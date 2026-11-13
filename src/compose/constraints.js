import { effectiveAbilities, effectiveMapRules } from "../runtime/rules.js";

/**
 * Resource constraint checking. Everything a package names — pool maps, effect
 * allows/denies/requires, ability overrides, requiresAbilities — must resolve
 * against the content catalog, and no round may collapse its playable map or
 * ability set to empty. These checks run at assembly time; the runtime never
 * re-checks them because a sealed package is only ever built through here.
 */

const fail = (code, message, details = {}) => ({ severity: "error", code, message, details });

/**
 * Collect every dangling content reference. Returns a flat list of
 * { kind, contentId, path } entries; empty when the package is self-contained.
 */
export function collectMissingReferences({ mapPools, abilities, rounds, catalog }) {
  const missing = [];
  const catalogMaps = new Set(Object.keys(catalog.maps));
  const catalogAbilities = new Set(Object.keys(catalog.abilities));
  const checkRefs = (kind, entries, path) => {
    for (const contentId of entries) {
      if (kind === "map" ? !catalogMaps.has(contentId) : !catalogAbilities.has(contentId)) {
        missing.push({ kind, contentId, path });
      }
    }
  };
  for (const [poolId, pool] of Object.entries(mapPools)) {
    checkRefs("map", pool.maps, `mapPool.${poolId}.maps`);
  }
  checkRefs("ability", abilities.allow, "abilities.allow");
  checkRefs("ability", abilities.deny, "abilities.deny");
  for (const round of rounds) {
    if (!mapPools[round.mapPoolId]) continue;
    for (const effect of round.effects) {
      if (effect.kind === "map") {
        checkRefs("map", [...effect.allow, ...effect.deny, ...effect.require], `schedule.rounds.${round.id}.effects`);
      }
      if (effect.kind === "ability") {
        checkRefs("ability", [...effect.allow, ...effect.deny], `schedule.rounds.${round.id}.effects`);
      }
    }
    checkRefs("ability", round.abilityOverrides.allow, `schedule.rounds.${round.id}.abilityOverrides`);
    checkRefs("ability", round.abilityOverrides.deny, `schedule.rounds.${round.id}.abilityOverrides`);
    checkRefs("ability", round.requiresAbilities, `schedule.rounds.${round.id}.requiresAbilities`);
  }
  return missing;
}

/** Wrap a missing-reference list into the assembly error, or null when clean. */
export function missingReferenceIssue(missing, { catalogDigest, prefix = "" } = {}) {
  if (!missing.length) return null;
  return fail("RESOURCE_REFERENCE_MISSING", `${prefix}package references content that is not defined`, {
    missing,
    catalogDigest,
  });
}

/**
 * A round whose effective ability set collapses to empty, or whose effective
 * map set collapses to empty, cannot host a match; refuse it at assembly time
 * rather than failing at match creation time.
 */
export function checkPlayableSets({ rounds, core, catalog, prefix = "" }) {
  const issues = [];
  for (const round of rounds) {
    const allowedAbilities = effectiveAbilities(core, catalog, round);
    if (Object.keys(catalog.abilities).length > 0 && allowedAbilities.length === 0) {
      issues.push(
        fail("ABILITY_SET_EMPTY", `${prefix}round ${round.id} leaves no usable ability`, {
          roundId: round.id,
        }),
      );
    }
    const mapRules = effectiveMapRules(core, round);
    if (mapRules.valid !== true && mapRules.reason === "NO_PLAYABLE_MAP") {
      issues.push(
        fail("MAP_SET_EMPTY", `${prefix}round ${round.id} leaves no playable map after restrictions`, {
          roundId: round.id,
          poolId: mapRules.poolId,
        }),
      );
    }
  }
  return issues;
}
