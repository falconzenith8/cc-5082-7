import { fingerprint, shortDigest } from "../fingerprint.js";

/**
 * Rule summaries. The same builders feed the standalone composition entry
 * (assemblePackage) and the online store entry, so a summary computed offline
 * is byte-identical to the one the live engine reports for the same package.
 */

export function scheduleInputDigest(rounds, mapPools, timeZone) {
  return fingerprint({
    timeZone,
    mapPool: mapPools,
    rounds: rounds.map((round) => ({
      id: round.id,
      startsAt: round.startsAt,
      endsAt: round.endsAt ?? null,
      mapPoolId: round.mapPoolId,
      winnerCondition: round.winnerCondition,
      effects: round.effects,
      abilityOverrides: round.abilityOverrides,
      requiresAbilities: round.requiresAbilities,
    })),
  });
}

/** Per-section input fingerprints: identity comes from content, not version names. */
export function summarizeInputs({
  rounds,
  mapPools,
  timeZone,
  defaults,
  scoringBase,
  perMapBonus,
  scoringCategories,
  abilities,
  composition,
  catalogDigest,
}) {
  return {
    schedule: scheduleInputDigest(rounds, mapPools, timeZone),
    defaults: fingerprint(defaults),
    mapPool: fingerprint(mapPools),
    scoring: fingerprint({ base: scoringBase, perMapBonus, categories: scoringCategories }),
    abilities: fingerprint(abilities),
    composition: fingerprint(composition),
    catalogDigest,
  };
}

/** Full human-facing summary attached to a sealed package. */
export function ruleSummary({ pkg, catalog, catalogDigest, summaryInputs, displayName, notes }) {
  const mapIds = [...new Set(Object.values(pkg.mapPool).flatMap((pool) => pool.maps))].sort();
  const abilityIds = [...new Set([...pkg.abilities.allow, ...pkg.abilities.deny])];
  const definedAbilityIds = Object.keys(catalog.abilities).sort();
  const tags = [...new Set([
    ...mapIds.flatMap((id) => catalog.maps[id]?.tags ?? []),
    ...definedAbilityIds.flatMap((id) => catalog.abilities[id]?.tags ?? []),
  ])].sort();
  const name =
    typeof displayName === "string" && displayName.trim()
      ? displayName.trim()
      : typeof pkg.notes === "string" && pkg.notes.trim()
        ? pkg.notes.trim()
        : `${pkg.id}@${pkg.publishedAt}`;
  return {
    displayName: name,
    notes: notes ?? null,
    digest: pkg.identity.digest,
    digestShort: shortDigest(pkg.identity.digest),
    catalogDigest,
    catalogDigestShort: shortDigest(catalogDigest),
    packageId: pkg.id,
    timeZone: pkg.timeZone,
    publishedAt: pkg.publishedAt,
    inputs: pkg.options,
    summaryInputs: summaryInputs ?? null,
    content: {
      maps: mapIds,
      abilities: definedAbilityIds,
      tags,
      mapPools: Object.keys(pkg.mapPool).sort(),
      rounds: pkg.schedule.rounds.map((round) => ({
        id: round.id,
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        startsAtInstant: round.startsAtInstant,
        endsAtInstant: round.endsAtInstant,
        mapPoolId: round.mapPoolId,
        winnerCondition: round.winnerCondition,
        effects: round.effects,
      })),
    },
  };
}
