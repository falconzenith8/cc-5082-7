const DAY_MS = 86_400_000;
const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

const formatterCache = new Map();

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone });
    fmt.format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}} */
export function civilFields(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

export function parseCivil(value) {
  if (typeof value !== "string") return null;
  const match = CIVIL_RE.exec(value);
  if (!match) return null;
  const fields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  if (!fieldsValid(fields)) return null;
  return fields;
}

function fieldsValid(f) {
  if (!Number.isInteger(f.year) || !Number.isInteger(f.month) || !Number.isInteger(f.day)) {
    return false;
  }
  if (f.month < 1 || f.month > 12 || f.day < 1 || f.day > 31) return false;
  if (f.hour < 0 || f.hour > 23 || f.minute < 0 || f.minute > 59) return false;
  if (f.second < 0 || f.second > 59) return false;
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const probe = new Date(asUtc);
  return (
    probe.getUTCFullYear() === f.year &&
    probe.getUTCMonth() === f.month - 1 &&
    probe.getUTCDate() === f.day &&
    probe.getUTCHours() === f.hour &&
    probe.getUTCMinutes() === f.minute &&
    probe.getUTCSeconds() === f.second
  );
}

export function formatCivil(fields) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(fields.day)}T${pad(
    fields.hour,
  )}:${pad(fields.minute)}:${pad(fields.second)}`;
}

function fieldsEqual(a, b) {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Offset of the zone at an instant, in milliseconds (local wall clock minus UTC).
 * Offsets have minute granularity for all modern zones, so instants are floored
 * to whole seconds before comparison.
 */
export function offsetAt(instant, timeZone) {
  const wholeSecond = Math.floor(instant / 1000) * 1000;
  const f = civilFields(wholeSecond, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - wholeSecond;
}

/**
 * Resolve a wall-clock (civil) datetime in a zone to an instant.
 * status: ok | ambiguous | nonexistent | invalid | bad-timezone
 */
export function resolveLocal(timeZone, civil) {
  if (!isValidTimeZone(timeZone)) {
    return { status: "bad-timezone", timeZone, civil, candidates: [] };
  }
  const fields = typeof civil === "string" ? parseCivil(civil) : civil;
  if (!fields || !fieldsValid(fields)) {
    return { status: "invalid", timeZone, civil, candidates: [] };
  }

  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );

  const candidates = new Set();
  for (const probe of [asUtc - 2 * DAY_MS, asUtc, asUtc + 2 * DAY_MS]) {
    const candidate = asUtc - offsetAt(probe, timeZone);
    if (fieldsEqual(civilFields(candidate, timeZone), fields)) {
      candidates.add(candidate);
    }
  }

  const sorted = [...candidates].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return { status: "ok", timeZone, civil: formatCivil(fields), instant: sorted[0], candidates: sorted };
  }
  if (sorted.length > 1) {
    return {
      status: "ambiguous",
      timeZone,
      civil: formatCivil(fields),
      instant: sorted[0],
      candidates: sorted,
    };
  }
  return {
    status: "nonexistent",
    timeZone,
    civil: formatCivil(fields),
    instant: null,
    candidates: [],
  };
}

export function parseInstant(value) {
  if (typeof value !== "string") return null;
  const match = INSTANT_RE.exec(value);
  if (!match) return null;
  const fields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  if (!fieldsValid(fields)) return null;
  const millis = Number((match[7] ?? "0").padEnd(3, "0"));
  const base = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    millis,
  );
  const offset = match[8];
  if (offset === "Z") return base;
  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return null;
  return base - sign * (hours * 60 + minutes) * 60_000;
}

export function civilIso(instant, timeZone) {
  return formatCivil(civilFields(instant, timeZone));
}

export function localDayKey(instant, timeZone) {
  return civilIso(instant, timeZone).slice(0, 10);
}

export function formatOffset(instant, timeZone) {
  const offset = offsetAt(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const totalMinutes = Math.abs(offset) / 60_000;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** e.g. 2026-11-13T00:00:00+08:00 */
export function formatLocal(instant, timeZone) {
  return `${civilIso(instant, timeZone)}${formatOffset(instant, timeZone)}`;
}

/**
 * Accepts an ISO instant (with offset), an IANA civil string in fallbackTimeZone,
 * or {local, timeZone}.
 */
export function parseWhen(when, fallbackTimeZone) {
  if (typeof when === "number") {
    return Number.isFinite(when)
      ? { status: "ok", instant: when, source: "instant", candidates: [when] }
      : { status: "invalid", instant: null, candidates: [], source: "instant", input: when };
  }
  if (when instanceof Date) {
    const instant = when.getTime();
    return Number.isFinite(instant)
      ? { status: "ok", instant, source: "instant", candidates: [instant] }
      : { status: "invalid", instant: null, candidates: [], source: "instant", input: when };
  }
  if (typeof when === "string") {
    const instant = parseInstant(when);
    if (instant !== null) {
      return { status: "ok", instant, source: "instant", candidates: [instant] };
    }
    if (fallbackTimeZone) {
      const resolved = resolveLocal(fallbackTimeZone, when);
      return { ...resolved, source: "local" };
    }
    return { status: "invalid", instant: null, candidates: [], source: "instant", input: when };
  }
  if (when && typeof when === "object") {
    const timeZone = when.timeZone ?? fallbackTimeZone;
    if (!timeZone) {
      return { status: "invalid", instant: null, candidates: [], source: "local", input: when };
    }
    const resolved = resolveLocal(timeZone, when.local);
    return { ...resolved, source: "local" };
  }
  return { status: "invalid", instant: null, candidates: [], source: "instant", input: when };
}

export class ClockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ClockError";
    this.code = code;
    this.details = details;
  }
}

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
