import test from "node:test";
import assert from "node:assert/strict";

import { SeasonEngine } from "../src/engine.js";
import { VirtualClock, resolveLocal, formatLocal, parseInstant } from "../src/time.js";
import { describeSelection, compareEntries } from "../src/report.js";
import { packageDigestMatches } from "../src/package.js";
import {
  catalog,
  v1,
  v2,
  invalidResourcePackage,
  unresolvedOverlapPackage,
  resolvedOverlapPackage,
  excludedOverlapPackage,
  gapPackage,
} from "../scenarios/scenario.js";

function engineAt(start = "2026-11-09T00:00:00Z") {
  return new SeasonEngine({ catalog, clock: new VirtualClock(start) });
}

function publishAt(engine, when, candidate, opts = {}) {
  engine.skipTo(when, { matchIds: [] });
  return engine.publish(candidate, opts);
}

test("assembly seals a digest over content, not over a version label", () => {
  const engine = engineAt();
  const result = publishAt(engine, "2026-11-10T00:00:00Z", v1);
  assert.equal(result.status, "published");
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(packageDigestMatches(result.entry.pkg));
  assert.equal(result.entry.pkg.identity.digest, result.digest);
});

test("cross-day activation honours the declared time zone boundary", () => {
  const engine = engineAt();
  assert.equal(publishAt(engine, "2026-11-10T00:00:00Z", v1).status, "published");
  const justBefore = engine.selectAt("2026-11-11T23:59:59+08:00");
  assert.equal(justBefore.status, "none");
  assert.equal(justBefore.reason, "NO_PACKAGE_BEFORE_INSTANT");
  const atBoundary = engine.selectAt("2026-11-12T00:00:00+08:00");
  assert.equal(atBoundary.status, "selected");
  assert.equal(atBoundary.version, 1);
  const afterBoundary = engine.selectAt("2026-11-12T09:00:00+08:00");
  assert.equal(afterBoundary.version, 1);
});

test("activation is not decided by UTC when the local day differs", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  // 2026-11-11T16:00:00Z == 2026-11-12T00:00:00+08:00
  assert.equal(engine.selectAt("2026-11-11T15:59:59Z").status, "none");
  assert.equal(engine.selectAt("2026-11-11T16:00:00Z").status, "selected");
});

test("a schedule gap resolves to no active round rather than silently reusing an old one", () => {
  const engine = engineAt();
  assert.equal(publishAt(engine, "2026-11-10T00:00:00Z", gapPackage).status, "published");
  // gapPackage is effective 2026-11-16T00:00 local and covers 11-12..11-13 and 11-15..11-16.
  const insideGap = engine.inspectRulesAt("2026-11-14T12:00:00+08:00");
  assert.equal(insideGap.status, "ok");
  assert.equal(insideGap.version, 1);
  assert.equal(insideGap.roundId, null);
  assert.deepEqual(insideGap.activeRounds, []);
  assert.equal(insideGap.scoringMultiplier, 1);
});

test("a gap package publishes with explicit warnings and no fallback claims", () => {
  const engine = engineAt();
  const result = publishAt(engine, "2026-11-10T00:00:00Z", gapPackage);
  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("SCHEDULE_GAP"));
  assert.ok(codes.includes("SCHEDULE_GAP_NO_FALLBACK"));
});

test("missing map definitions refuse the package instead of generating a usable one", () => {
  const engine = engineAt();
  const result = publishAt(engine, "2026-11-10T00:00:00Z", invalidResourcePackage);
  assert.equal(result.status, "refused");
  assert.deepEqual(result.reasonCodes, ["RESOURCE_REFERENCE_MISSING"]);
  assert.equal(engine.store.head(), null);
  const missing = result.errors[0].details.missing;
  const ids = new Set(missing.map((entry) => `${entry.kind}:${entry.contentId}`));
  assert.ok(ids.has("map:glacier-rift"));
  assert.ok(ids.has("ability:grapple-hook"));
  assert.ok(ids.has("ability:orbit-scan"));
});

test("missing ability definitions refuse the package", () => {
  const engine = engineAt();
  const onlyAbility = {
    ...v1,
    id: "season-abilities-broken",
    schedule: {
      rounds: v1.schedule.rounds.map((round) => ({
        ...round,
        effects: [...round.effects, { kind: "ability", allow: ["phase-cloak"], deny: [] }],
      })),
    },
  };
  const result = publishAt(engine, "2026-11-10T00:00:00Z", onlyAbility);
  assert.equal(result.status, "refused");
  assert.ok(result.errors.some((error) => error.code === "RESOURCE_REFERENCE_MISSING"));
  assert.ok(
    result.errors[0].details.missing.some((entry) => entry.kind === "ability" && entry.contentId === "phase-cloak"),
  );
});

test("unresolved overlap refuses; declared priority assembles; exclusion assembles", () => {
  const unresolvedEngine = engineAt();
  const unresolved = publishAt(unresolvedEngine, "2026-11-10T00:00:00Z", unresolvedOverlapPackage);
  assert.equal(unresolved.status, "refused");
  assert.ok(unresolved.reasonCodes.includes("ROUND_OVERLAP_UNRESOLVED"));
  const detail = unresolved.errors.find((error) => error.code === "ROUND_OVERLAP_UNRESOLVED");
  assert.equal(detail.details.reason, "UNRESOLVED_TIE");

  const priorityEngine = engineAt();
  assert.equal(publishAt(priorityEngine, "2026-11-10T00:00:00Z", resolvedOverlapPackage).status, "published");

  const excludedEngine = engineAt();
  assert.equal(publishAt(excludedEngine, "2026-11-10T00:00:00Z", excludedOverlapPackage).status, "published");
});

test("priority order decides which overlapping activity supplies the multiplier", () => {
  const engine = engineAt();
  const result = publishAt(engine, "2026-11-10T00:00:00Z", resolvedOverlapPackage);
  assert.equal(result.status, "published");
  engine.skipTo("2026-11-12T06:00:00+08:00", { matchIds: [] });
  const inspection = engine.inspectRulesAt(engine.clock.now());
  assert.equal(inspection.status, "ok");
  assert.equal(inspection.winningRound, "sprint");
  assert.equal(inspection.scoringMultiplier, 1.5);
  engine.startMatch({ matchId: "priority-match", at: engine.clock.now() });
  const event = engine.reportResult("priority-match", { kind: "map-result", side: "a", mapId: "neon-docks" });
  assert.equal(event.points, 15);
});

test("excluded overlapping activities block the match rather than stacking", () => {
  const engine = engineAt();
  const result = publishAt(engine, "2026-11-10T00:00:00Z", excludedOverlapPackage);
  assert.equal(result.status, "published");
  engine.skipTo("2026-11-12T06:00:00+08:00", { matchIds: [] });
  const inspection = engine.inspectRulesAt(engine.clock.now());
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.reason, "STACK_BLOCKED");
  assert.throws(
    () => engine.startMatch({ matchId: "blocked", at: engine.clock.now() }),
    (error) => error.code === "MATCH_STACK_BLOCKED",
  );
  assert.equal(engine.getMatch("blocked"), null);
});

test("a version released mid-match cannot change the outcome conditions", () => {
  const engine = engineAt();
  assert.equal(publishAt(engine, "2026-11-10T00:00:00Z", v1).status, "published");
  engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
  const match = engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
  assert.equal(match.pin.version, 1);

  const beforeScore = engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks" });
  assert.equal(beforeScore.points, 15);
  assert.equal(beforeScore.multiplier, 1.5);
  assert.equal(engine.getMatch("alpha").scores.a, 15);

  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["alpha"] });
  const v2Result = engine.publish(v2);
  assert.equal(v2Result.status, "published");
  assert.equal(engine.store.head().version, 2);

  // The match keeps v1 scoring even though v2 is now the newest package.
  const afterScore = engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "highland-pass" });
  assert.equal(afterScore.multiplier, 1.5);
  assert.equal(afterScore.packageVersion, 1);
  assert.equal(engine.getMatch("alpha").scores.a, 30);
  assert.equal(engine.resolveMatch("alpha").mustContinueWith, 1);
});

test("two parallel matches spanning a rotation boundary really use different rules", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
  engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
  engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks" });

  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["alpha"] });
  assert.equal(engine.publish(v2).status, "published");
  engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: ["alpha"] });
  engine.startMatch({ matchId: "beta", at: "2026-11-13T09:00:00+08:00" });
  engine.reportResult("beta", { kind: "map-result", side: "a", mapId: "highland-pass" });

  const comparison = engine.compareObservations("alpha", "beta");
  assert.equal(comparison.samePackage, false);
  const fields = comparison.differences.map((difference) => difference.field);
  for (const field of ["packageVersion", "packageDigest", "roundId", "scoringMultiplier", "allowedMaps", "allowedAbilities", "scores"]) {
    assert.ok(fields.includes(field), `expected ${field} to differ`);
  }
  assert.equal(comparison.a.scoringMultiplier, 1.5);
  assert.equal(comparison.b.scoringMultiplier, 0.8);
  assert.deepEqual(comparison.a.allowedMaps, ["highland-pass", "neon-docks"]);
  assert.deepEqual(comparison.b.allowedMaps, ["frost-cavern", "highland-pass"]);
  assert.ok(comparison.a.allowedAbilities.includes("blink"));
  assert.ok(!comparison.b.allowedAbilities.includes("blink"));
  assert.ok(!comparison.b.allowedAbilities.includes("drone"));
  assert.deepEqual(comparison.a.scores, { a: 15, b: 0 });
  assert.deepEqual(comparison.b.scores, { a: 8, b: 0 });
});

test("points and restrictions change inside a match only when the package does", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
  engine.startMatch({ matchId: "sprint-match", at: "2026-11-12T20:00:00+08:00" });
  const sprintEvent = engine.reportResult("sprint-match", { kind: "map-result", side: "a", mapId: "highland-pass" });
  assert.equal(sprintEvent.points, 15);
  assert.equal(sprintEvent.multiplier, 1.5);
  assert.ok(engine.getMatch("sprint-match").rulesView().allowedAbilities.includes("drone"));

  // A fresh match after the v2 boundary scores the same map differently.
  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["sprint-match"] });
  assert.equal(engine.publish(v2).status, "published");
  engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: ["sprint-match"] });
  engine.startMatch({ matchId: "climber-match", at: "2026-11-13T09:00:00+08:00" });
  const climberEvent = engine.reportResult("climber-match", { kind: "map-result", side: "a", mapId: "highland-pass" });
  assert.equal(climberEvent.points, 8);
  assert.equal(climberEvent.multiplier, 0.8);
  assert.ok(!engine.getMatch("climber-match").rulesView().allowedAbilities.includes("drone"));
});

test("a match refuses a map or ability its pinned rules exclude", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: [] });
  engine.startMatch({ matchId: "climber", at: "2026-11-13T09:00:00+08:00" });
  assert.throws(
    () => engine.reportResult("climber", { kind: "map-result", side: "a", mapId: "neon-docks" }),
    (error) => error.code === "MATCH_MAP_NOT_ALLOWED",
  );
  assert.throws(
    () => engine.reportResult("climber", { kind: "map-result", side: "a", mapId: "highland-pass", abilityId: "blink" }),
    (error) => error.code === "MATCH_ABILITY_NOT_ALLOWED",
  );
  assert.equal(engine.getMatch("climber").scores.a, 0);
});

test("score summary is tied to concrete input configuration, not display name", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: [] });
  assert.equal(engine.publish(v2).status, "published");

  const comparison = compareEntries(engine.store, 1, 2);
  assert.equal(comparison.sameDigest, false);
  assert.equal(comparison.sameInputs, false);
  assert.deepEqual(comparison.changedInputs.sort(), ["abilities", "schedule"]);
  const summaryOne = describeSelection(engine.store, engine.store.get(1));
  const summaryTwo = describeSelection(engine.store, engine.store.get(2));
  assert.notEqual(summaryOne.inputDigests.schedule, summaryTwo.inputDigests.schedule);
  assert.notEqual(summaryOne.inputDigests.abilities, summaryTwo.inputDigests.abilities);
  assert.equal(summaryOne.inputDigests.mapPool, summaryTwo.inputDigests.mapPool);
});

test("two packages with the same display name but different content get different identities", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  const renamedOnly = {
    ...v2,
    id: "season-26-autumn",
    publishedAt: "2026-11-12T00:00:00Z",
    effectiveFrom: "2026-11-13T00:00:00",
    displayName: v1.displayName,
  };
  const result = engine.publish(renamedOnly);
  assert.equal(result.status, "published");
  const comparison = compareEntries(engine.store, 1, 2);
  assert.equal(comparison.sameDisplayName, true);
  assert.equal(comparison.sameDigest, false);
  assert.equal(comparison.sameInputs, false);
});

test("rollback republishes earlier inputs as a new version without touching live matches", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
  engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["alpha"] });
  assert.equal(engine.publish(v2).status, "published");
  engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: ["alpha"] });
  engine.startMatch({ matchId: "beta", at: "2026-11-13T09:00:00+08:00" });

  engine.skipTo("2026-11-13T20:00:00+08:00", { matchIds: ["alpha", "beta"] });
  const rollback = engine.rollback({
    toVersion: 1,
    at: "2026-11-14T00:00:00+08:00",
    publishedAt: "2026-11-13T20:00:00+08:00",
  });
  assert.equal(rollback.status, "published");
  assert.equal(rollback.version, 3);

  const rebuilt = engine.store.get(3);
  const source = engine.store.get(1);
  for (const section of ["schedule", "scoring", "abilities", "mapPool", "composition"]) {
    assert.equal(
      rebuilt.diagnostics.summaryInputs[section],
      source.diagnostics.summaryInputs[section],
      `${section} inputs should be replayed exactly`,
    );
  }
  assert.notEqual(rebuilt.digest, source.digest, "a rollback is a new package identity");

  // Existing matches do not change versions, and the rolled-back inputs become
  // effective for new matches from the boundary onward.
  assert.equal(engine.getMatch("alpha").pin.version, 1);
  assert.equal(engine.getMatch("beta").pin.version, 2);
  assert.equal(engine.resolveMatch("beta").ok, true);
  assert.equal(engine.selectAt("2026-11-14T01:00:00+08:00").version, 3);
  engine.skipTo("2026-11-14T09:00:00+08:00", { matchIds: ["alpha", "beta"] });
  engine.startMatch({ matchId: "gamma", at: "2026-11-14T09:00:00+08:00" });
  assert.equal(engine.getMatch("gamma").pin.version, 3);
  assert.equal(engine.getMatch("gamma").effectiveRound().rounds.length, 0);
});

test("a rollback target that does not exist is refused with a reason code", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  const rollback = engine.rollback({ toVersion: 99, at: "2026-11-14T00:00:00+08:00" });
  assert.equal(rollback.status, "refused");
  assert.deepEqual(rollback.reasonCodes, ["ROLLBACK_VERSION_UNKNOWN"]);
});

test("a degraded content catalog refuses a republish that still references removed content", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  const degraded = { ...catalog, maps: { ...catalog.maps } };
  delete degraded.maps["frost-cavern"];
  const result = engine.publish(
    {
      ...v2,
      id: "season-26-autumn-v3",
      publishedAt: "2026-11-14T00:00:00+08:00",
      effectiveFrom: "2026-11-15T00:00:00+08:00",
    },
    { catalog: degraded, catalogDigest: "sha256:" + "0".repeat(64) },
  );
  assert.equal(result.status, "refused");
  assert.ok(result.reasonCodes.includes("RESOURCE_REFERENCE_MISSING"));
  const missing = result.errors[0].details.missing;
  assert.ok(missing.every((entry) => entry.contentId === "frost-cavern"));
});

test("a content change at an unadvanced publishedAt is refused", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  const sameStamp = {
    ...v2,
    publishedAt: v1.publishedAt,
    effectiveFrom: "2026-11-13T00:00:00",
  };
  const result = engine.publish(sameStamp);
  assert.equal(result.status, "refused");
  assert.deepEqual(result.reasonCodes, ["PUBLISH_SAME_PUBLISHED_AT"]);
});

test("inspection reports sub-1 multipliers without clamping to 1", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: [] });
  const inspection = engine.inspectRulesAt(engine.clock.now());
  assert.equal(inspection.status, "ok");
  assert.equal(inspection.roundId, "climber");
  assert.equal(inspection.scoringMultiplier, 0.5);
});

test("a round whose ability restrictions empty the pool is refused at assembly", () => {
  const engine = engineAt();
  const denyAll = {
    ...v1,
    id: "season-no-abilities",
    abilities: { defaultAllowed: false, allow: [], deny: [] },
    schedule: {
      rounds: v1.schedule.rounds.map((round) => ({
        ...round,
        effects: round.effects.filter((effect) => effect.kind === "scoring"),
        abilityOverrides: { defaultAllowed: false, allow: [], deny: [] },
      })),
    },
  };
  const result = publishAt(engine, "2026-11-10T00:00:00Z", denyAll);
  assert.equal(result.status, "refused");
  assert.ok(result.reasonCodes.includes("ABILITY_SET_EMPTY"));
  assert.equal(engine.store.head(), null);
});

test("a round whose map restrictions empty the pool is refused at assembly", () => {
  const engine = engineAt();
  const denyAllMaps = {
    ...v1,
    id: "season-no-maps",
    schedule: {
      rounds: v1.schedule.rounds.map((round) => ({
        ...round,
        effects: [
          ...round.effects.filter((effect) => effect.kind === "scoring"),
          { kind: "map", allow: [], deny: ["neon-docks", "highland-pass", "frost-cavern"], require: [] },
        ],
      })),
    },
  };
  const result = publishAt(engine, "2026-11-10T00:00:00Z", denyAllMaps);
  assert.equal(result.status, "refused");
  assert.ok(result.reasonCodes.includes("MAP_SET_EMPTY"));
});

test("an ability allow-list adds access without narrowing the open package", () => {
  const engine = engineAt();
  const open = {
    ...v1,
    id: "season-open-abilities",
    abilities: { defaultAllowed: true, allow: [], deny: [] },
    schedule: {
      rounds: v1.schedule.rounds.map((round) => ({
        ...round,
        effects: [...round.effects.filter((effect) => effect.kind === "scoring"), { kind: "ability", allow: ["blink"], deny: [] }],
      })),
    },
  };
  const result = publishAt(engine, "2026-11-10T00:00:00Z", open);
  assert.equal(result.status, "published");
  const inspection = engine.inspectRulesAt("2026-11-12T20:00:00+08:00");
  assert.ok(inspection.allowedAbilities.includes("drone"));
  assert.ok(inspection.allowedAbilities.includes("blink"));
});

test("an identical candidate is reported as a duplicate rather than a new version", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  const identical = { ...v1 };
  const result = engine.publish(identical);
  assert.equal(result.status, "duplicate");
  assert.equal(result.version, 1);
  assert.deepEqual(engine.store.versions(), [1]);
});

test("a content change at an unadvanced publishedAt is refused", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", v1);
  const changed = { ...v2, publishedAt: v1.publishedAt, effectiveFrom: "2026-11-13T00:00:00" };
  const result = engine.publish(changed);
  assert.equal(result.status, "refused");
  assert.deepEqual(result.reasonCodes, ["PUBLISH_SAME_PUBLISHED_AT"]);
});

test("optimistic concurrency rejects a publish against a stale head digest", () => {
  const engine = engineAt();
  const first = publishAt(engine, "2026-11-10T00:00:00Z", v1);
  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: [] });
  assert.equal(engine.publish(v2).status, "published");
  engine.skipTo("2026-11-14T00:00:00+08:00", { matchIds: [] });
  const stale = engine.publish(
    {
      ...v2,
      id: "season-26-autumn-v3",
      publishedAt: "2026-11-14T00:00:00+08:00",
      effectiveFrom: "2026-11-15T00:00:00+08:00",
    },
    { expectCurrentDigest: first.digest },
  );
  assert.equal(stale.status, "refused");
  assert.deepEqual(stale.reasonCodes, ["VERSION_CONFLICT"]);
});

test("the time skip tool refuses to move the clock backwards", () => {
  const engine = engineAt();
  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: [] });
  assert.throws(
    () => engine.skipTo("2026-11-12T00:00:00+08:00", { matchIds: [] }),
    (error) => error.code === "CLOCK_BACKWARDS",
  );
});

test("crossing midnight in the declared zone advances exactly one local day", () => {
  const before = resolveLocal("Asia/Shanghai", "2026-11-12T23:59:59");
  const after = resolveLocal("Asia/Shanghai", "2026-11-13T00:00:00");
  assert.equal(before.status, "ok");
  assert.equal(after.status, "ok");
  assert.equal(after.instant - before.instant, 1000);
  assert.equal(formatLocal(after.instant, "Asia/Shanghai"), "2026-11-13T00:00:00+08:00");
});

test("a nonexistent local time (DST spring forward) is reported, not silently shifted", () => {
  const resolved = resolveLocal("America/New_York", "2026-03-08T02:30:00");
  assert.equal(resolved.status, "nonexistent");
  assert.ok(resolveLocal("America/New_York", "2026-03-08T01:30:00").status === "ok");
});

test("an ambiguous local time (DST fall back) is reported with both candidates", () => {
  const resolved = resolveLocal("America/New_York", "2026-11-01T01:30:00");
  assert.equal(resolved.status, "ambiguous");
  assert.equal(resolved.candidates.length, 2);
  assert.equal(parseInstant("2026-11-01T05:30:00Z"), resolved.candidates[0]);
  assert.equal(parseInstant("2026-11-01T06:30:00Z"), resolved.candidates[1]);
});

test("a package with a nonexistent round start is refused", () => {
  const engine = engineAt();
  const result = engine.publish({
    ...v1,
    id: "dst-broken",
    publishedAt: "2026-11-10T00:00:00Z",
    effectiveFrom: "2026-11-12T00:00:00",
    timeZone: "America/New_York",
    schedule: {
      rounds: [
        {
          id: "spring",
          startsAt: "2026-03-08T02:30:00",
          endsAt: "2026-03-08T05:00:00",
          mapPoolId: "ranked",
          effects: [],
        },
      ],
    },
  });
  assert.equal(result.status, "refused");
  assert.ok(result.reasonCodes.includes("ROUND_START_NONEXISTENT"));
});

test("the engine stores refusals with their stage for later inspection", () => {
  const engine = engineAt();
  publishAt(engine, "2026-11-10T00:00:00Z", invalidResourcePackage);
  assert.equal(engine.store.head(), null);
  assert.equal(engine.refusals.length, 1);
  assert.equal(engine.refusals[0].stage, "assemble");
  assert.deepEqual(engine.refusals[0].result.reasonCodes, ["RESOURCE_REFERENCE_MISSING"]);
});
