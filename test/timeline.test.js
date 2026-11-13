import test from "node:test";
import assert from "node:assert/strict";

import { SeasonEngine } from "../src/runtime/engine.js";
import { VirtualClock } from "../src/time/clock.js";
import { describeTimeline } from "../src/runtime/timeline.js";
import { catalog, v1, v2 } from "../scenarios/scenario.js";

function prepare() {
  const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
  engine.skipTo("2026-11-10T00:00:00Z", { matchIds: [] });
  assert.equal(engine.publish(v1).status, "published");
  engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
  engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
  engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["alpha"] });
  assert.equal(engine.publish(v2).status, "published");
  engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: ["alpha"] });
  engine.startMatch({ matchId: "beta", at: "2026-11-13T09:00:00+08:00" });
  return engine;
}

test("timeline keeps each match frozen on the round it started with", () => {
  const engine = prepare();
  const timeline = engine.timeline(["alpha", "beta"], {
    from: "2026-11-12T18:00:00+08:00",
    to: "2026-11-13T12:00:00+08:00",
  });
  assert.equal(timeline.matches.length, 2);
  assert.equal(timeline.changingRules, true);
  assert.equal(timeline.boundaries.length, 1);
  assert.equal(timeline.boundaries[0].version, 2);

  const alpha = timeline.matches.find((match) => match.matchId === "alpha");
  const beta = timeline.matches.find((match) => match.matchId === "beta");
  assert.equal(alpha.pinnedVersion, 1);
  assert.equal(beta.pinnedVersion, 2);
  assert.equal(alpha.frozenRound, "sprint");
  assert.equal(beta.frozenRound, "climber");
  assert.equal(alpha.frozenMultiplier, 1.5);
  assert.equal(beta.frozenMultiplier, 0.8);

  // Across the boundary alpha's package would hand a new match the climber
  // round, yet alpha's own frozen binding never moves.
  const afterBoundary = alpha.samples.filter((sample) => sample.at >= timeline.boundaries[0].at);
  assert.ok(afterBoundary.length > 0);
  assert.ok(afterBoundary.every((sample) => sample.frozenRound === "sprint"));
  assert.ok(afterBoundary.some((sample) => sample.packageWouldSelect.winner === "climber"));
});

test("timeline renders divergent multipliers for the same wall clock", () => {
  const engine = prepare();
  const timeline = engine.timeline(["alpha", "beta"], {
    from: "2026-11-12T18:00:00+08:00",
    to: "2026-11-13T10:00:00+08:00",
  });
  const text = describeTimeline(timeline);
  assert.match(text, /v2 .*effective 2026-11-13T00:00:00\+08:00/);
  const alpha = timeline.matches.find((match) => match.matchId === "alpha");
  const beta = timeline.matches.find((match) => match.matchId === "beta");
  assert.equal(alpha.frozenMultiplier, 1.5);
  assert.equal(beta.frozenMultiplier, 0.8);
  for (const match of [alpha, beta]) {
    assert.ok(match.samples.every((sample) => sample.frozenMultiplier === match.frozenMultiplier));
  }
  const afterBoundary = timeline.matches.map((match) => ({
    matchId: match.matchId,
    frozen: match.samples
      .filter((sample) => sample.at >= timeline.boundaries[0].at)
      .map((sample) => sample.frozenMultiplier),
  }));
  assert.equal(afterBoundary[0].frozen.every((value) => value === 1.5), true);
  assert.equal(afterBoundary[1].frozen.every((value) => value === 0.8), true);
  assert.notEqual(afterBoundary[0].frozen[0], afterBoundary[1].frozen[0]);
});
