import test from "node:test";
import assert from "node:assert/strict";

import { RulePackageView } from "../src/runtime/view.js";
import { assemblePackage } from "../src/compose/assemble.js";
import { SeasonEngine } from "../src/runtime/engine.js";
import { VirtualClock } from "../src/time/clock.js";
import { normalizeCatalog } from "../src/catalog.js";
import { catalog, v1, v2, excludedOverlapPackage } from "../scenarios/scenario.js";

const { catalog: normalizedCatalog, digest: catalogDigest } = normalizeCatalog(catalog);

function viewOf(raw) {
  const assembled = assemblePackage(raw, { catalog: normalizedCatalog, catalogDigest });
  return new RulePackageView({ pkg: assembled.package, catalog: normalizedCatalog });
}

const T = "2026-11-12T20:00:00+08:00";
const T_MS = Date.parse(T);

test("rule view caches frozen snapshots per instant; cache never crosses packages", () => {
  const view1 = viewOf(v1);
  const a = view1.rulesAt(T_MS);
  assert.equal(a, view1.rulesAt(T_MS), "same instant returns the same frozen object");
  assert.ok(Object.isFrozen(a));
  assert.throws(() => {
    a.scoringMultiplier = 99;
  }, TypeError);

  const view2 = viewOf(v2);
  const b = view2.rulesAt(T_MS);
  assert.notEqual(a, b);
  assert.equal(a.scoringMultiplier, 1.5);
  assert.equal(b.scoringMultiplier, 1.75, "v2 view resolves from its own package, not v1's cache");

  // Resolution-level cache behaves the same way.
  assert.equal(view1.resolutionAt(T_MS), view1.resolutionAt(T_MS));
  assert.notEqual(view1.resolutionAt(T_MS), view2.resolutionAt(T_MS));
});

test("view status codes propagate: blocked stacks and unavailable rounds stay coded", () => {
  const blocked = viewOf(excludedOverlapPackage).rulesAt(Date.parse("2026-11-12T06:00:00+08:00"));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "STACK_BLOCKED");
  assert.equal(blocked.stacking.reason, "EXCLUDED_PAIR");

  const view = viewOf(v1);
  const missing = view.rulesAt(T_MS, { roundId: "nonexistent" });
  assert.equal(missing.status, "none");
  assert.equal(missing.reason, "ROUND_UNAVAILABLE");
});

test("engine queries return frozen snapshots that cannot mutate live rule objects", () => {
  const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
  engine.skipTo("2026-11-10T00:00:00Z", { matchIds: [] });
  assert.equal(engine.publish(v1).status, "published");

  const selection = engine.selectAt(T);
  assert.equal(selection.status, "selected");
  assert.ok(Object.isFrozen(selection));
  assert.ok(Object.isFrozen(selection.entry));
  assert.throws(() => {
    selection.entry.version = 99;
  }, TypeError);
  assert.throws(() => {
    selection.entry.pkg.scoring.base = 999;
  }, TypeError);
  assert.equal(engine.store.head().version, 1, "store entry is untouched by the query");

  const inspection = engine.inspectRulesAt(T);
  assert.ok(Object.isFrozen(inspection));
  assert.ok(Object.isFrozen(inspection.mapRules));

  const observations = engine.observations([]);
  assert.ok(Object.isFrozen(observations));
});

test("a live match keeps adjudicating from its frozen view after a refused publish", () => {
  const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
  engine.skipTo("2026-11-10T00:00:00Z", { matchIds: [] });
  engine.publish(v1);
  engine.skipTo(T, { matchIds: [] });
  engine.startMatch({ matchId: "alpha", at: T });

  const view = engine.getMatch("alpha").view;
  assert.ok(view instanceof RulePackageView);
  assert.equal(view.rulesAt(T_MS), view.rulesAt(T_MS));

  const event = engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks" });
  assert.equal(event.points, 15);
  assert.equal(event.packageVersion, 1);
});
