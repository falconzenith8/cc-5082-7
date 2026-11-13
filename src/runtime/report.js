import { explainSelection } from "./store.js";
import { packageDigestMatches } from "./package.js";
import { formatLocal } from "../time/civil.js";

/**
 * Digest-backed selection summary. Identity comes from the package content and
 * the input sections, never from a human-typed version name: two packages with
 * the same display name but different scoring produce different digests and
 * different inputDiff entries.
 */
export function describeSelection(store, entry) {
  if (!entry) return null;
  const inputs = entry.diagnostics?.summaryInputs ?? {};
  const inputDigests = Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [key, typeof value === "string" ? value : String(value)]),
  );
  const inputsFingerprint = Object.values(inputDigests).join("|");
  return {
    version: entry.version,
    displayName: entry.displayName,
    digest: entry.digest,
    digestShort: entry.summary?.digestShort ?? entry.digest,
    packageId: entry.pkg.id,
    publishedAt: entry.pkg.publishedAt,
    effectiveFrom: entry.effectiveFrom,
    effectiveFromLocal: entry.effectiveFromLocal,
    timeZone: entry.pkg.timeZone,
    inputDigests,
    inputFingerprint: inputsFingerprint,
    catalogDigest: entry.catalogDigest,
    catalogDigestShort: entry.summary?.catalogDigestShort ?? null,
    integrityOk: packageDigestMatches(entry.pkg),
    rounds: entry.pkg.schedule.rounds.map((round) => ({
      id: round.id,
      local: {
        start: formatLocal(Date.parse(round.startsAtInstant), entry.pkg.timeZone),
        end: round.endsAtInstant ? formatLocal(Date.parse(round.endsAtInstant), entry.pkg.timeZone) : null,
      },
    })),
  };
}

export function compareEntries(store, versionA, versionB) {
  const a = store.get(versionA);
  const b = store.get(versionB);
  if (!a || !b) return null;
  const explanation = explainSelection(a, b);
  const sa = describeSelection(store, a);
  const sb = describeSelection(store, b);
  return {
    a: sa,
    b: sb,
    sameDisplayName: sa.displayName === sb.displayName,
    sameDigest: sa.digest === sb.digest,
    sameInputs: explanation?.sameInputs ?? null,
    changedInputs: explanation?.inputDiff.map((change) => change.input) ?? [],
    inputDiff: explanation?.inputDiff ?? [],
  };
}
