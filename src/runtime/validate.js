import { packageDigestMatches } from "./package.js";
import { lookupDefinition } from "../catalog.js";

/**
 * Validate a full snapshot (already-published packages + an optional landing
 * candidate) against one content catalog. This is the safety gate for
 * publication: if the check passes, no match already under way can have its
 * win/loss conditions rewritten by the new version.
 */
export function validateSnapshot({ store, now, candidate = null, catalog, catalogDigest }) {
  const errors = [];
  const warnings = [];
  const fail = (code, message, details = {}) => errors.push({ severity: "error", code, message, details });

  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    fail("SNAPSHOT_NOW", "snapshot validation requires a resolvable now");
    return finish();
  }
  if (!catalog) {
    fail("SNAPSHOT_CATALOG", "snapshot validation requires the content catalog");
    return finish();
  }

  const entries = [...store.listEntries()];
  if (candidate) {
    entries.push({
      version: candidate.version,
      digest: candidate.digest,
      pkg: { ...candidate.core, identity: { digest: candidate.digest } },
      catalog,
      catalogDigest,
      effectiveFrom: new Date(candidate.effectiveFrom).toISOString(),
      displayName: candidate.displayName ?? null,
      summary: null,
      diagnostics: {},
    });
  }

  const digestOwners = new Map();
  for (const entry of entries) {
    const label = `v${entry.version}`;
    if (entry.digest) {
      if (digestOwners.has(entry.digest) && digestOwners.get(entry.digest).version !== entry.version) {
        fail("SNAPSHOT_CONTENT_ANCHOR", `versions ${digestOwners.get(entry.digest).version} and ${entry.version} share a digest`, {
          digest: entry.digest,
        });
      }
      digestOwners.set(entry.digest, entry);
    }
    if (entry.digest && entry.pkg?.identity?.digest && !packageDigestMatches(entry.pkg)) {
      fail("SNAPSHOT_PACKAGE_INTEGRITY", `${label} identity digest does not match its content`, {
        version: entry.version,
        digest: entry.digest,
      });
    }
  }

  if (candidate) {
    const publishedAt = Date.parse(candidate.core?.publishedAt ?? "");
    if (Number.isFinite(publishedAt) && candidate.effectiveFrom < publishedAt) {
      fail("SNAPSHOT_EFFECTIVE_BEFORE_PUBLISHED", "candidate effectiveFrom precedes publishedAt", {
        effectiveFrom: candidate.effectiveFrom,
        publishedAt: candidate.core?.publishedAt,
      });
    }
    for (const round of candidate.core?.schedule?.rounds ?? []) {
      const missing = [];
      const check = (kind, ids) => {
        const section = kind === "map" ? "maps" : "abilities";
        for (const id of ids) {
          if (lookupDefinition(catalog, section, id) === null) missing.push({ kind, contentId: id });
        }
      };
      const pool = candidate.core?.mapPool?.[round.mapPoolId];
      check("map", pool?.maps ?? []);
      for (const effect of round.effects ?? []) {
        if (effect.kind === "map") check("map", [...effect.allow, ...effect.deny, ...effect.require]);
        if (effect.kind === "ability") check("ability", [...effect.allow, ...effect.deny]);
      }
      check("ability", round.abilityOverrides?.allow ?? []);
      check("ability", round.abilityOverrides?.deny ?? []);
      check("ability", round.requiresAbilities ?? []);
      if (missing.length) {
        fail("SNAPSHOT_RESOURCE_REFERENCE_MISSING", `v${candidate.version}:${round.id} references undefined content`, {
          version: candidate.version,
          roundId: round.id,
          missing,
        });
      }
    }
  }

  return finish();

  function finish() {
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      reasonCodes: errors.map((error) => error.code),
    };
  }
}
