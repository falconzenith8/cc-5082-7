import { parseWhen, civilIso } from "./civil.js";

/**
 * Schedule layer: parses round time windows and answers time-only queries.
 * It knows nothing about map pools, scoring, abilities or catalogs, so it can
 * be exercised without any game scenario — feed it raw round windows and ask
 * what is active at an instant.
 */

export const fail = (code, message, details = {}) => ({ severity: "error", code, message, details });
export const notice = (code, message, details = {}) => ({ severity: "warning", code, message, details });

/** Round instants may be epoch milliseconds (in-memory rounds) or ISO strings (sealed packages). */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundWindow(round) {
  const start = toMs(round.startsAtInstant ?? round.startMs);
  if (start === null) return null;
  const rawEnd = toMs(round.endsAtInstant ?? round.endMs);
  const end = rawEnd === null ? Infinity : rawEnd;
  return { start, end };
}

export function roundsOverlap(a, b) {
  const wa = roundWindow(a);
  const wb = roundWindow(b);
  if (!wa || !wb) return false;
  return wa.start < wb.end && wb.start < wa.end;
}

export function isRoundActiveAt(round, instant) {
  const window = roundWindow(round);
  if (!window) return false;
  return instant >= window.start && instant < window.end;
}

/**
 * Rounds active at an instant. `source` may be a rounds array, a
 * `{ schedule: { rounds } }` shape, or a whole package core.
 */
export function activeRoundsAt(source, instant) {
  const rounds = Array.isArray(source) ? source : (source?.schedule?.rounds ?? source?.rounds ?? []);
  return rounds.filter((round) => isRoundActiveAt(round, instant));
}

/**
 * Read-only view over a set of parsed round windows. Pure time queries; the
 * same view backs assembly-time schedule analysis and runtime inspection.
 */
export class ScheduleView {
  constructor(rounds = []) {
    this.rounds = [...rounds];
    Object.freeze(this.rounds);
    Object.freeze(this);
  }

  activeAt(instant) {
    return this.rounds.filter((round) => isRoundActiveAt(round, instant));
  }

  windows() {
    return this.rounds
      .map((round) => ({ round, window: roundWindow(round) }))
      .filter((entry) => entry.window !== null);
  }

  /** Pairs of rounds whose windows can be simultaneously active. */
  overlappingPairs() {
    const pairs = [];
    const windows = this.windows();
    for (let i = 0; i < windows.length; i += 1) {
      for (let j = i + 1; j < windows.length; j += 1) {
        if (roundsOverlap(windows[i].round, windows[j].round)) {
          pairs.push([windows[i].round, windows[j].round]);
        }
      }
    }
    return pairs;
  }

  /**
   * Holes between consecutive bounded rounds, in start order. Open-ended and
   * unparseable rounds do not participate.
   */
  gaps() {
    const ordered = this.rounds
      .map((round) => ({ round, window: roundWindow(round) }))
      .filter((entry) => entry.window !== null && entry.window.end !== Infinity)
      .sort((a, b) => a.window.start - b.window.start || a.round.id.localeCompare(b.round.id));
    const gaps = [];
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const current = ordered[i];
      const next = ordered[i + 1];
      if (next.window.start > current.window.end) {
        gaps.push({ after: current.round, before: next.round, start: current.window.end, end: next.window.start });
      }
    }
    return gaps;
  }
}

/**
 * Resolve one round's startsAt/endsAt against a time zone. Returns instants in
 * ms (null when absent/unresolvable) plus diagnostics using the same codes the
 * assembler has always emitted.
 */
export function parseRoundWindow({ startsAt, endsAt }, timeZone, { path = "round" } = {}) {
  const issues = [];

  const starts = parseWhen(startsAt, timeZone);
  let startsAtInstant = starts.instant;
  if (starts.status === "nonexistent") {
    issues.push(fail("ROUND_START_NONEXISTENT", `${path}.startsAt does not exist in ${timeZone}`, { local: starts.civil }));
  } else if (starts.status === "ambiguous") {
    issues.push(notice("ROUND_START_AMBIGUOUS", `${path}.startsAt occurs twice in ${timeZone}; earliest kept`, {
      local: starts.civil,
      candidates: starts.candidates.map((instant) => new Date(instant).toISOString()),
    }));
  } else if (starts.status !== "ok") {
    issues.push(fail("ROUND_START_INVALID", `${path}.startsAt is invalid`, { status: starts.status }));
  }

  let endsAtInstant = null;
  if (endsAt !== undefined && endsAt !== null) {
    const ends = parseWhen(endsAt, timeZone);
    if (ends.status === "nonexistent") {
      issues.push(fail("ROUND_END_NONEXISTENT", `${path}.endsAt does not exist in ${timeZone}`, { local: ends.civil }));
    } else if (ends.status === "ambiguous") {
      issues.push(notice("ROUND_END_AMBIGUOUS", `${path}.endsAt occurs twice in ${timeZone}; earliest kept`, {
        local: ends.civil,
      }));
    } else if (ends.status !== "ok") {
      issues.push(fail("ROUND_END_INVALID", `${path}.endsAt is invalid`, { status: ends.status }));
    } else {
      endsAtInstant = ends.instant;
      if (startsAtInstant !== null && endsAtInstant <= startsAtInstant) {
        issues.push(fail("ROUND_END_ORDER", `${path}.endsAt must be after startsAt`));
      }
    }
  }

  return { startsAtInstant, endsAtInstant, issues };
}

/**
 * Whole-schedule analysis: gap detection, fallback-pool coverage and window
 * overlap notices. Message texts are part of the published diagnostics
 * contract and must not drift.
 */
export function analyzeSchedule(rounds, { timeZone, hasFallbackPool, prefix = "" } = {}) {
  const issues = [];
  const gaps = [];

  const ordered = rounds
    .map((round) => ({ round, window: roundWindow(round) }))
    .filter((entry) => entry.window !== null && entry.window.end !== Infinity)
    .sort((a, b) => a.window.start - b.window.start || a.round.id.localeCompare(b.round.id));

  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const current = ordered[i].round;
    const next = ordered[i + 1].round;
    if (ordered[i + 1].window.start > ordered[i].window.end) {
      const detail = {
        afterRound: current.id,
        beforeRound: next.id,
        gapStart: new Date(ordered[i].window.end).toISOString(),
        gapEnd: new Date(ordered[i + 1].window.start).toISOString(),
        gapStartLocal: civilIso(ordered[i].window.end, timeZone),
        gapEndLocal: civilIso(ordered[i + 1].window.start, timeZone),
        coveredByDefaultPool: hasFallbackPool,
      };
      gaps.push(detail);
      issues.push(notice("SCHEDULE_GAP", `${prefix}no round covers the gap after ${current.id}`, detail));
      if (!hasFallbackPool) {
        issues.push(
          notice("SCHEDULE_GAP_NO_FALLBACK", `${prefix}gap after ${current.id} has no defaults.mapPoolId fallback`, {
            afterRound: current.id,
            beforeRound: next.id,
          }),
        );
      }
    }
    if (ordered[i + 1].window.start < ordered[i].window.end) {
      issues.push(
        notice("ROUND_WINDOW_OVERLAP", `${prefix}round ${next.id} starts before ${current.id} ends`, {
          rounds: [current.id, next.id],
        }),
      );
    }
  }

  const openEnded = rounds.filter((round) => round.startsAtInstant !== null && round.endsAtInstant === null);
  const coverage = {
    earliest: ordered.length ? ordered[0].window.start : null,
    latest: ordered.length ? ordered[ordered.length - 1].window.end : null,
    openEnded: openEnded.map((round) => round.id),
    gaps: gaps.length,
    hasFallbackPool,
  };

  return { issues, gaps, coverage };
}
