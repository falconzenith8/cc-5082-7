import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot fingerprint non-finite number");
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (type === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  throw new TypeError(`cannot fingerprint value of type ${type}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function fingerprint(value) {
  const hash = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `sha256:${hash}`;
}

export function shortDigest(digest, length = 8) {
  const body = digest?.startsWith("sha256:") ? digest.slice("sha256:".length) : String(digest ?? "");
  return body.slice(0, length);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Structural deep diff used by package diagnostics. Arrays must already be order-normalized. */
export function structuralDiff(a, b, path = "") {
  if (Object.is(a, b)) return [];
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return [{ path: path || "/", from: a, to: b }];
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return [{ path: path || "/", from: a, to: b }];
    }
    if (a.length !== b.length) {
      return [{ path: `${path}/length`, from: a.length, to: b.length }];
    }
    const changes = [];
    for (let i = 0; i < a.length; i += 1) {
      changes.push(...structuralDiff(a[i], b[i], `${path}/${i}`));
    }
    return changes;
  }
  const changes = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    changes.push(...structuralDiff(a[key], b[key], `${path}/${key}`));
  }
  return changes;
}
