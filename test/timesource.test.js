import test from "node:test";
import assert from "node:assert/strict";

import { SeasonEngine } from "../src/runtime/engine.js";
import { VirtualClock } from "../src/time/clock.js";
import { catalog, v1, invalidResourcePackage } from "../scenarios/scenario.js";

/**
 * The engine never reads a wall clock: the time source is injected explicitly,
 * and a failed candidate publication must not poison the package a live match
 * (or a later selection) already relies on.
 */

test("the engine refuses to run without an explicitly injected time source", () => {
  assert.throws(() => new SeasonEngine({ catalog }), (error) => error.code === "TIME_SOURCE_REQUIRED");
  assert.throws(
    () => new SeasonEngine({ catalog, timeSource: { now: () => Number.NaN } }),
    (error) => error.code === "TIME_SOURCE_INVALID",
  );
});

test("a custom time source drives publication, reporting and history", () => {
  let now = Date.parse("2026-11-10T00:00:00Z");
  const engine = new SeasonEngine({ catalog, timeSource: { now: () => now } });

  assert.equal(engine.publish(v1).status, "published");
  now = Date.parse("2026-11-12T20:00:00+08:00");
  engine.startMatch({ matchId: "m", at: "2026-11-12T20:00:00+08:00" });
  const event = engine.reportResult("m", { kind: "map-result", side: "a", mapId: "neon-docks" });
  assert.equal(event.at, now, "report timestamp comes from the injected source");
  assert.ok(engine.history.every((entry) => Number.isFinite(entry.at)));

  // skipTo cannot drive an immutable source; the error is explicit, not silent.
  assert.throws(
    () => engine.skipTo("2026-11-13T00:00:00+08:00"),
    (error) => error.code === "TIME_SOURCE_IMMUTABLE",
  );
});

test("clock errors propagate with their codes across the engine boundary", () => {
  const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-12T00:00:00Z") });
  engine.skipTo("2026-11-13T00:00:00Z", { matchIds: [] });
  assert.throws(
    () => engine.skipTo("2026-11-12T00:00:00Z", { matchIds: [] }),
    (error) => error.code === "CLOCK_BACKWARDS",
  );
});

test("a refused candidate leaves the old package loadable and live matches untouched", () => {
  const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
  engine.skipTo("2026-11-10T00:00:00Z", { matchIds: [] });
  assert.equal(engine.publish(v1).status, "published");
  engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
  engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
  const before = engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks" });
  assert.equal(before.points, 15);

  const refused = engine.publish(invalidResourcePackage);
  assert.equal(refused.status, "refused");
  assert.deepEqual(refused.reasonCodes, ["RESOURCE_REFERENCE_MISSING"]);

  // The old package still loads: head unchanged, selection unchanged.
  assert.equal(engine.store.head().version, 1);
  assert.ok(engine.store.get(1));
  const selection = engine.selectAt("2026-11-12T21:00:00+08:00");
  assert.equal(selection.status, "selected");
  assert.equal(selection.version, 1);

  // The live match still adjudicates with the same pinned rules.
  const after = engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "highland-pass" });
  assert.equal(after.multiplier, 1.5);
  assert.equal(after.packageVersion, 1);
  assert.equal(engine.getMatch("alpha").scores.a, 30);
  assert.equal(engine.resolveMatch("alpha").ok, true);

  // And the refusal is recorded for the season-rules UI to surface.
  assert.equal(engine.refusals.length, 1);
  assert.equal(engine.refusals[0].result.reasonCodes[0], "RESOURCE_REFERENCE_MISSING");
});
