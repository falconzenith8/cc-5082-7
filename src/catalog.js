import { fingerprint } from "./fingerprint.js";
import { isValidTimeZone } from "./time.js";

/**
 * Content catalog: immutable definitions (maps, abilities) keyed by contentId.
 * Persisted form:
 * {
 *   format: "season-content", schemaVersion: 1,
 *   maps: { [contentId]: { contentId, name, revision, size?, tags? } },
 *   abilities: { [contentId]: { contentId, name, revision, kind?, tags? } }
 * }
 */
export class CatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
    this.details = details;
  }
}

const SECTION_KEYS = ["maps", "abilities"];

export function normalizeCatalog(raw, { label = "catalog" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CatalogError("CATALOG_SHAPE", `${label}: catalog must be an object`);
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new CatalogError("CATALOG_SCHEMA", `${label}: unsupported schemaVersion ${raw.schemaVersion}`);
  }
  const definitions = {};
  const errors = [];
  for (const section of SECTION_KEYS) {
    const value = raw[section] ?? {};
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${section} must be an object keyed by contentId`);
      continue;
    }
    definitions[section] = {};
    for (const [contentId, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${section}.${contentId}: definition must be an object`);
        continue;
      }
      if (!contentId.trim()) {
        errors.push(`${section}: empty contentId`);
        continue;
      }
      if (entry.contentId !== undefined && entry.contentId !== contentId) {
        errors.push(`${section}.${contentId}: contentId mismatch (${entry.contentId})`);
        continue;
      }
      const definition = {
        contentId,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name : contentId,
        revision: entry.revision ?? 1,
        tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
        ...(entry.attributes !== undefined ? { attributes: entry.attributes } : {}),
      };
      definitions[section][contentId] = definition;
    }
  }
  if (errors.length) {
    throw new CatalogError("CATALOG_DEFINITIONS", `${label}: invalid catalog definitions`, { errors });
  }
  const payload = {
    format: "season-content",
    schemaVersion: 1,
    maps: definitions.maps,
    abilities: definitions.abilities,
  };
  return { catalog: payload, digest: fingerprint(payload) };
}

export function lookupDefinition(catalog, section, contentId) {
  if (!SECTION_KEYS.includes(section)) throw new CatalogError("CATALOG_SECTION", `unknown section ${section}`);
  return catalog?.[section]?.[contentId] ?? null;
}

export function isSupportedTimeZone(timeZone) {
  return isValidTimeZone(timeZone);
}

