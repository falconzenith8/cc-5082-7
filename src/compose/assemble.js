import { sealPackage } from "../runtime/package.js";
import { deepFreeze } from "../fingerprint.js";
import { normalizePackage } from "./normalize.js";
import { ruleSummary } from "./summary.js";

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * Composition entry point. Assemble (and seal) a package only when it is fully
 * usable. Refusal is a first-class result: callers receive diagnostics plus
 * the exact refusal reason codes, and no sealed package is produced.
 *
 * The assembled package is deep-frozen here: what the composition layer hands
 * out is the same immutable object the store, the matches and the read-only
 * runtime views will later share.
 */
export function assemblePackage(raw, { catalog, catalogDigest, label } = {}) {
  const normalized = normalizePackage(raw, { catalog, catalogDigest, label });
  if (!normalized.ok) {
    return {
      status: "refused",
      id: normalized.core.id || null,
      label: label ?? null,
      errors: normalized.errors,
      warnings: normalized.warnings,
      reasonCodes: uniqueSorted(normalized.errors.map((issue) => issue.code)),
      missing: normalized.missing,
      catalog: normalized.catalog,
      catalogDigest: normalized.catalogDigest,
      summaryInputs: normalized.summaryInputs,
    };
  }
  const sealed = deepFreeze(sealPackage(normalized.core));
  const summary = ruleSummary({
    pkg: sealed,
    catalog: normalized.catalog,
    catalogDigest: normalized.catalogDigest,
    summaryInputs: normalized.summaryInputs,
    displayName: raw.displayName,
    notes: raw.notes ?? null,
  });
  return {
    status: "assembled",
    package: sealed,
    catalog: normalized.catalog,
    catalogDigest: normalized.catalogDigest,
    errors: [],
    warnings: normalized.warnings,
    referencedTags: normalized.referencedTags,
    summaryInputs: normalized.summaryInputs,
    summary,
    rounds: normalized.rounds,
  };
}
