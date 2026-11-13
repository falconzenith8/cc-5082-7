import { parseInstant, parseWhen } from "./civil.js";

export class ClockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ClockError";
    this.code = code;
    this.details = details;
  }
}

/**
 * A time source is any object with `now(): number`. The engine never reads a
 * wall clock itself; callers inject the source of instants explicitly, so a
 * season switch is always attributable to a caller-supplied time.
 *
 * VirtualClock is the controllable implementation used by tests, the demo and
 * the UI server. It additionally supports `set`, `advanceBy` and `advanceTo`
 * for time-skip tooling; an injected source without those methods is treated
 * as immutable and `skipTo` refuses to drive it.
 */
export class VirtualClock {
  #instant;

  constructor(start = "2026-11-12T00:00:00Z") {
    const instant = typeof start === "number" ? start : parseInstant(start);
    if (instant === null) throw new ClockError("CLOCK_INVALID_START", `invalid clock start: ${start}`);
    this.#instant = instant;
  }

  now() {
    return this.#instant;
  }

  nowIso() {
    return new Date(this.#instant).toISOString();
  }

  set(instant) {
    const value = typeof instant === "number" ? instant : parseInstant(instant);
    if (value === null) throw new ClockError("CLOCK_INVALID_INSTANT", `invalid instant: ${instant}`);
    this.#instant = value;
    return this.#instant;
  }

  advanceBy(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new ClockError("CLOCK_BACKWARDS", `cannot advance by ${ms}ms`, { now: this.#instant });
    }
    const from = this.#instant;
    this.#instant += ms;
    return { from, to: this.#instant, elapsedMs: ms };
  }

  /** Time-skip tool. `when` may be an ISO instant or a local civil datetime with timeZone. */
  advanceTo(when, fallbackTimeZone) {
    const parsed = parseWhen(when, fallbackTimeZone);
    if (parsed.status !== "ok") {
      throw new ClockError("CLOCK_INVALID_TARGET", `cannot resolve time skip target`, {
        status: parsed.status,
        when,
      });
    }
    if (parsed.instant < this.#instant) {
      throw new ClockError("CLOCK_BACKWARDS", "time skip target is before current clock", {
        now: this.#instant,
        target: parsed.instant,
      });
    }
    const from = this.#instant;
    this.#instant = parsed.instant;
    return { from, to: this.#instant, elapsedMs: this.#instant - from };
  }
}

/** Validate an injected time source; returns it unchanged when usable. */
export function requireTimeSource(timeSource) {
  if (!timeSource || typeof timeSource.now !== "function") {
    throw new ClockError("TIME_SOURCE_REQUIRED", "a time source with now(): number must be injected explicitly");
  }
  const instant = timeSource.now();
  if (!Number.isFinite(instant)) {
    throw new ClockError("TIME_SOURCE_INVALID", "time source now() must return a finite instant (ms)");
  }
  return timeSource;
}
