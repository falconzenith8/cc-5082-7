import test from "node:test";
import assert from "node:assert/strict";

import {
  ScheduleView,
  parseRoundWindow,
  analyzeSchedule,
  activeRoundsAt,
  roundsOverlap,
} from "../src/time/schedule.js";

/**
 * The schedule layer is pure time: no catalog, no map pools, no scoring, no
 * engine. These tests exercise it without any game scenario.
 */

const Z = (iso) => Date.parse(iso);

test("parseRoundWindow resolves plain local windows against a time zone", () => {
  const parsed = parseRoundWindow(
    { startsAt: "2026-11-12T00:00:00", endsAt: "2026-11-13T00:00:00" },
    "Asia/Shanghai",
    { path: "rounds[0]" },
  );
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.startsAtInstant, Z("2026-11-12T00:00:00+08:00"));
  assert.equal(parsed.endsAtInstant, Z("2026-11-13T00:00:00+08:00"));
});

test("parseRoundWindow reports DST-nonexistent starts and keeps diagnostics local to time", () => {
  const parsed = parseRoundWindow({ startsAt: "2026-03-08T02:30:00" }, "America/New_York", { path: "rounds[0]" });
  assert.equal(parsed.startsAtInstant, null);
  assert.ok(parsed.issues.some((issue) => issue.code === "ROUND_START_NONEXISTENT" && issue.severity === "error"));

  const ambiguous = parseRoundWindow({ startsAt: "2026-11-01T01:30:00" }, "America/New_York", { path: "rounds[0]" });
  assert.ok(ambiguous.issues.some((issue) => issue.code === "ROUND_START_AMBIGUOUS" && issue.severity === "warning"));
  assert.equal(ambiguous.startsAtInstant, Z("2026-11-01T05:30:00Z"));

  const ordered = parseRoundWindow(
    { startsAt: "2026-11-13T00:00:00", endsAt: "2026-11-12T00:00:00" },
    "Asia/Shanghai",
    { path: "rounds[0]" },
  );
  assert.ok(ordered.issues.some((issue) => issue.code === "ROUND_END_ORDER"));
});

test("ScheduleView answers activity, overlap and gap queries from bare windows", () => {
  const view = new ScheduleView([
    { id: "a", startsAtInstant: Z("2026-11-12T00:00:00Z"), endsAtInstant: Z("2026-11-13T00:00:00Z") },
    { id: "b", startsAtInstant: Z("2026-11-12T12:00:00Z"), endsAtInstant: Z("2026-11-14T00:00:00Z") },
    { id: "c", startsAtInstant: Z("2026-11-16T00:00:00Z"), endsAtInstant: Z("2026-11-17T00:00:00Z") },
  ]);
  assert.deepEqual(view.activeAt(Z("2026-11-12T06:00:00Z")).map((round) => round.id), ["a"]);
  assert.deepEqual(view.activeAt(Z("2026-11-12T18:00:00Z")).map((round) => round.id), ["a", "b"]);
  assert.deepEqual(view.activeAt(Z("2026-11-15T00:00:00Z")), []);
  assert.equal(view.overlappingPairs().length, 1);
  const gaps = view.gaps();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].after.id, "b");
  assert.equal(gaps[0].before.id, "c");
});

test("activeRoundsAt accepts a bare rounds array — no package core required", () => {
  const rounds = [
    { id: "x", startsAtInstant: Z("2026-11-12T00:00:00Z"), endsAtInstant: Z("2026-11-13T00:00:00Z") },
    { id: "y", startsAtInstant: "2026-11-13T00:00:00.000Z", endsAtInstant: "2026-11-14T00:00:00.000Z" },
  ];
  assert.deepEqual(activeRoundsAt(rounds, Z("2026-11-12T12:00:00Z")).map((round) => round.id), ["x"]);
  assert.deepEqual(activeRoundsAt(rounds, Z("2026-11-13T00:00:00Z")).map((round) => round.id), ["y"]);
  assert.equal(roundsOverlap(rounds[0], rounds[1]), false);
});

test("analyzeSchedule emits gap and fallback diagnostics with no game objects involved", () => {
  const rounds = [
    { id: "a", startsAtInstant: Z("2026-11-12T00:00:00Z"), endsAtInstant: Z("2026-11-13T00:00:00Z") },
    { id: "b", startsAtInstant: Z("2026-11-15T00:00:00Z"), endsAtInstant: Z("2026-11-16T00:00:00Z") },
  ];
  const analysis = analyzeSchedule(rounds, { timeZone: "Asia/Shanghai", hasFallbackPool: false, prefix: "" });
  const codes = analysis.issues.map((issue) => issue.code);
  assert.ok(codes.includes("SCHEDULE_GAP"));
  assert.ok(codes.includes("SCHEDULE_GAP_NO_FALLBACK"));
  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.coverage.gaps, 1);
  assert.equal(analysis.coverage.hasFallbackPool, false);

  const covered = analyzeSchedule(rounds, { timeZone: "Asia/Shanghai", hasFallbackPool: true, prefix: "" });
  assert.ok(!covered.issues.some((issue) => issue.code === "SCHEDULE_GAP_NO_FALLBACK"));
});
