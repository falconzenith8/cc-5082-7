import test from "node:test";
import assert from "node:assert/strict";

import { assemblePackage } from "../src/compose/assemble.js";
import { collectMissingReferences, checkPlayableSets } from "../src/compose/constraints.js";
import { SeasonEngine } from "../src/runtime/engine.js";
import { inspectAssembledPackage } from "../src/runtime/inspect.js";
import { describeSelection } from "../src/runtime/report.js";
import { VirtualClock } from "../src/time/clock.js";
import { normalizeCatalog } from "../src/catalog.js";
import { catalog, v1, v2, invalidResourcePackage } from "../scenarios/scenario.js";

const { catalog: normalizedCatalog, digest: catalogDigest } = normalizeCatalog(catalog);

function engineAt(start = "2026-11-09T00:00:00Z") {
  return new SeasonEngine({ catalog, timeSource: new VirtualClock(start) });
}

test("standalone composition produces the same rule summary as the online entry", () => {
  const standalone = assemblePackage(v1, { catalog: normalizedCatalog, catalogDigest });
  assert.equal(standalone.status, "assembled");

  const engine = engineAt();
  const published = engine.publish(v1, { now: Date.parse("2026-11-10T00:00:00Z") });
  assert.equal(published.status, "published");

  // Same input digests, same full summary, same package identity.
  assert.deepEqual(standalone.summaryInputs, published.entry.diagnostics.summaryInputs);
  assert.deepEqual(standalone.summary, published.summary);
  assert.equal(standalone.summary.digest, published.digest);

  // And the summary the reporting layer derives online matches too.
  const described = describeSelection(engine.store, engine.store.get(1));
  assert.equal(described.digest, standalone.summary.digest);
  assert.deepEqual(described.inputDigests, Object.fromEntries(Object.entries(standalone.summaryInputs)));
});

test("offline inspection of a standalone package matches the online rule view", () => {
  const standalone = assemblePackage(v2, { catalog: normalizedCatalog, catalogDigest });
  const engine = engineAt();
  assert.equal(engine.publish(v2, { now: Date.parse("2026-11-12T13:00:00+08:00") }).status, "published");

  const offline = inspectAssembledPackage(standalone, "2026-11-13T09:00:00");
  const online = engine.inspectRulesAt("2026-11-13T09:00:00+08:00");
  assert.equal(offline.status, "ok");
  assert.equal(online.status, "ok");
  assert.equal(offline.digest, online.digest);
  assert.equal(offline.winningRound, online.winningRound);
  assert.equal(offline.scoringMultiplier, online.scoringMultiplier);
  assert.deepEqual(offline.mapRules.allowedMaps, online.mapRules.allowedMaps);
  assert.deepEqual(offline.allowedAbilities, online.allowedAbilities);
});

test("assembled packages are frozen: the composition layer hands out immutable rule packages", () => {
  const standalone = assemblePackage(v1, { catalog: normalizedCatalog, catalogDigest });
  assert.ok(Object.isFrozen(standalone.package));
  assert.ok(Object.isFrozen(standalone.package.schedule.rounds));
  assert.throws(() => {
    standalone.package.scoring.base = 999;
  }, TypeError);
});

test("resource constraints are checkable on their own and report every dangling reference", () => {
  const missing = collectMissingReferences({
    mapPools: { winter: { maps: ["glacier-rift", "neon-docks"], defaultMap: "glacier-rift" } },
    abilities: { defaultAllowed: true, allow: [], deny: [] },
    rounds: [
      {
        id: "winter",
        mapPoolId: "winter",
        effects: [{ kind: "ability", allow: ["grapple-hook"], deny: [] }],
        abilityOverrides: { defaultAllowed: null, allow: [], deny: [] },
        requiresAbilities: ["orbit-scan"],
      },
    ],
    catalog: normalizedCatalog,
  });
  const ids = new Set(missing.map((entry) => `${entry.kind}:${entry.contentId}`));
  assert.ok(ids.has("map:glacier-rift"));
  assert.ok(ids.has("ability:grapple-hook"));
  assert.ok(ids.has("ability:orbit-scan"));
  assert.ok(!ids.has("map:neon-docks"));
});

test("playable-set constraints flag rounds that collapse to empty", () => {
  const core = {
    schedule: { rounds: [] },
    mapPool: { ranked: { maps: ["neon-docks"], defaultMap: "neon-docks" } },
    abilities: { defaultAllowed: false, allow: [], deny: [] },
    composition: { precedence: "newest", combine: "exclusive", allowTies: false, priority: [], exclusions: [] },
  };
  const round = {
    id: "locked",
    mapPoolId: "ranked",
    effects: [{ kind: "map", allow: [], deny: ["neon-docks"], require: [] }],
    abilityOverrides: { defaultAllowed: null, allow: [], deny: [] },
  };
  const issues = checkPlayableSets({ rounds: [round], core, catalog: normalizedCatalog });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("ABILITY_SET_EMPTY"));
  assert.ok(codes.includes("MAP_SET_EMPTY"));
});

test("a refused assembly keeps its reason codes and never yields a package", () => {
  const refused = assemblePackage(invalidResourcePackage, { catalog: normalizedCatalog, catalogDigest });
  assert.equal(refused.status, "refused");
  assert.deepEqual(refused.reasonCodes, ["RESOURCE_REFERENCE_MISSING"]);
  assert.equal(refused.package, undefined);
});
