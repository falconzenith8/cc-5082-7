import { fingerprint } from "../fingerprint.js";
import { PackageError } from "../runtime/package.js";
import { isValidTimeZone, parseWhen } from "../time/civil.js";
import { parseRoundWindow, analyzeSchedule, roundsOverlap, fail, notice } from "../time/schedule.js";
import { normalizeCatalog, lookupDefinition } from "../catalog.js";
import { stackResolution } from "../runtime/rules.js";
import { collectMissingReferences, missingReferenceIssue, checkPlayableSets } from "./constraints.js";
import { summarizeInputs } from "./summary.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRECEDENCE = new Set(["newest", "oldest", "declared"]);
const COMBINE = new Set(["exclusive", "multiply"]);
const ROUND_EFFECT_KINDS = new Set(["scoring", "map", "ability"]);

function readArray(value, path, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(fail("SHAPE_ARRAY", `${path} must be an array`));
    return [];
  }
  return value;
}

function readStringList(value, path, issues) {
  const list = readArray(value, path, issues);
  const out = [];
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.push(fail("SHAPE_STRING", `${path}[${index}] must be a non-empty string`));
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/** Preserves declaration order; used for ordered precedence lists. */
function orderedUnique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function difference(a, b) {
  const setB = new Set(b);
  return a.filter((entry) => !setB.has(entry));
}

/**
 * Normalize and validate a raw published package against a content catalog.
 * Returns { ok, core, catalog, warnings, errors, summaryInputs }.
 * `core` is the input-only package content that gets sealed; it never embeds
 * derived state and never embeds the content catalog snapshot.
 *
 * Round time windows come from the schedule layer (../time/schedule.js);
 * resource constraints from ./constraints.js; input summaries from
 * ./summary.js. Issue order is part of the diagnostics contract.
 */
export function normalizePackage(raw, { label = "", catalog, catalogDigest } = {}) {
  const issues = [];
  const prefix = label ? `${label}: ` : "";

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PackageError("PACKAGE_SHAPE", `${prefix}package must be an object`);
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_RE.test(id)) issues.push(fail("PACKAGE_ID", `${prefix}id must match ${ID_RE}`));

  if (!isValidTimeZone(raw.timeZone)) {
    issues.push(fail("PACKAGE_TIMEZONE", `${prefix}timeZone is not a supported IANA zone`, { timeZone: raw.timeZone }));
  }
  const timeZone = isValidTimeZone(raw.timeZone) ? raw.timeZone : "UTC";

  const published = parseWhen(raw.publishedAt, timeZone);
  let publishedAt = published.instant;
  if (published.status !== "ok") {
    issues.push(fail("PACKAGE_PUBLISHED_AT", `${prefix}publishedAt is not resolvable`, { status: published.status }));
  }

  const sourceCatalog =
    catalog ??
    (raw.catalog !== undefined ? normalizeCatalog(raw.catalog, { label: `${prefix}catalog` }).catalog : null);
  let sourceCatalogDigest = catalogDigest;
  if (!sourceCatalog || !sourceCatalogDigest) {
    const normalized = normalizeCatalog(sourceCatalog ?? raw.catalog, { label: `${prefix}catalog` });
    sourceCatalog = normalized.catalog;
    sourceCatalogDigest = normalized.digest;
  }
  if (typeof raw.catalogDigest === "string" && raw.catalogDigest !== sourceCatalogDigest) {
    issues.push(
      fail("CONTENT_DIGEST_MISMATCH", `${prefix}catalogDigest does not match the supplied content catalog`, {
        declared: raw.catalogDigest,
        actual: sourceCatalogDigest,
      }),
    );
  }

  // ---- scoring ---------------------------------------------------------
  const scoringRaw = raw.scoring ?? {};
  let scoringBase = null;
  if (!scoringRaw || typeof scoringRaw !== "object" || Array.isArray(scoringRaw)) {
    issues.push(fail("SCORING_SHAPE", `${prefix}scoring must be an object`));
  } else if (!Number.isFinite(scoringRaw.base) || scoringRaw.base <= 0) {
    issues.push(fail("SCORING_BASE", `${prefix}scoring.base must be a positive finite number`));
  } else {
    scoringBase = scoringRaw.base;
  }
  const perMapBonus = {};
  if (scoringRaw?.perMapBonus !== undefined) {
    if (typeof scoringRaw.perMapBonus !== "object" || Array.isArray(scoringRaw.perMapBonus)) {
      issues.push(fail("SCORING_BONUS_SHAPE", `${prefix}scoring.perMapBonus must be an object`));
    } else {
      for (const [mapId, points] of Object.entries(scoringRaw.perMapBonus)) {
        if (!Number.isFinite(points)) {
          issues.push(fail("SCORING_BONUS_VALUE", `${prefix}scoring.perMapBonus.${mapId} must be finite`));
        } else {
          perMapBonus[mapId] = points;
        }
      }
    }
  }
  const scoringCategories = readStringList(scoringRaw?.categories, `${prefix}scoring.categories`, issues);

  // ---- map pools -------------------------------------------------------
  const mapPools = {};
  const mapPoolRaw = raw.mapPool ?? {};
  if (typeof mapPoolRaw !== "object" || Array.isArray(mapPoolRaw)) {
    issues.push(fail("MAPPOOL_SHAPE", `${prefix}mapPool must be an object keyed by pool id`));
  } else {
    for (const [poolId, pool] of Object.entries(mapPoolRaw)) {
      const path = `${prefix}mapPool.${poolId}`;
      if (!ID_RE.test(poolId)) issues.push(fail("MAPPOOL_ID", `${path}: invalid pool id`));
      if (!pool || typeof pool !== "object" || Array.isArray(pool)) {
        issues.push(fail("MAPPOOL_ENTRY_SHAPE", `${path} must be an object`));
        continue;
      }
      const maps = uniqueSorted(readStringList(pool.maps, `${path}.maps`, issues));
      if (maps.length === 0) {
        issues.push(fail("MAPPOOL_EMPTY", `${path}.maps must list at least one map`));
      }
      const defaultMap = typeof pool.defaultMap === "string" ? pool.defaultMap.trim() : maps[0] ?? null;
      if (defaultMap && !maps.includes(defaultMap)) {
        issues.push(fail("MAPPOOL_DEFAULT", `${path}.defaultMap must be one of the pool maps`, { defaultMap }));
      }
      mapPools[poolId] = { maps, defaultMap };
    }
  }

  // ---- abilities -------------------------------------------------------
  const abilitiesRaw = raw.abilities ?? {};
  let abilities = { defaultAllowed: false, allow: [], deny: [] };
  if (!abilitiesRaw || typeof abilitiesRaw !== "object" || Array.isArray(abilitiesRaw)) {
    issues.push(fail("ABILITIES_SHAPE", `${prefix}abilities must be an object`));
  } else {
    abilities = {
      defaultAllowed: Boolean(abilitiesRaw.defaultAllowed),
      allow: uniqueSorted(readStringList(abilitiesRaw.allow, `${prefix}abilities.allow`, issues)),
      deny: uniqueSorted(readStringList(abilitiesRaw.deny, `${prefix}abilities.deny`, issues)),
    };
    const both = abilities.allow.filter((entry) => abilities.deny.includes(entry));
    if (both.length) {
      issues.push(fail("ABILITY_SELF_CONTRADICTION", `${prefix}abilities allow and deny overlap`, { abilities: both }));
    }
  }

  // ---- composition -----------------------------------------------------
  const compositionRaw = raw.composition ?? {};
  let composition = {
    precedence: "newest",
    combine: "exclusive",
    allowTies: false,
    priority: [],
    exclusions: [],
  };
  if (!compositionRaw || typeof compositionRaw !== "object" || Array.isArray(compositionRaw)) {
    issues.push(fail("COMPOSITION_SHAPE", `${prefix}composition must be an object`));
  } else {
    const precedence = compositionRaw.precedence ?? "newest";
    if (!PRECEDENCE.has(precedence)) {
      issues.push(fail("COMPOSITION_PRECEDENCE", `${prefix}composition.precedence must be newest|oldest|declared`));
    }
    const combine = compositionRaw.combine ?? "exclusive";
    if (!COMBINE.has(combine)) {
      issues.push(fail("COMPOSITION_COMBINE", `${prefix}composition.combine must be exclusive|multiply`));
    }
    const allowTies = Boolean(compositionRaw.allowTies);
    const priority = orderedUnique(
      readStringList(compositionRaw.priority, `${prefix}composition.priority`, issues),
    );
    if (precedence === "declared" && priority.length === 0) {
      issues.push(fail("COMPOSITION_PRIORITY", `${prefix}composition.precedence=declared requires priority entries`));
    }
    const exclusions = [];
    for (const [index, entry] of readArray(compositionRaw.exclusions, `${prefix}composition.exclusions`, issues).entries()) {
      const ids = Array.isArray(entry) ? entry : entry && typeof entry === "object" ? [entry.a, entry.b] : null;
      if (!ids || ids.length !== 2 || typeof ids[0] !== "string" || typeof ids[1] !== "string") {
        issues.push(fail("COMPOSITION_EXCLUSION", `${prefix}composition.exclusions[${index}] must be { a, b }`));
        continue;
      }
      const [a, b] = ids.map((value) => value.trim());
      if (a === b) {
        issues.push(fail("COMPOSITION_EXCLUSION_SELF", `${prefix}composition.exclusions[${index}] excludes itself`));
        continue;
      }
      exclusions.push(Object.freeze({ a: a < b ? a : b, b: a < b ? b : a }));
    }
    composition = { precedence, combine, allowTies, priority, exclusions };
  }

  // ---- schedule --------------------------------------------------------
  const scheduleRaw = raw.schedule ?? {};
  const roundsRaw = readArray(scheduleRaw.rounds, `${prefix}schedule.rounds`, issues);
  const rounds = [];
  const roundIds = new Set();
  if (roundsRaw.length === 0) {
    issues.push(fail("SCHEDULE_EMPTY", `${prefix}schedule.rounds must contain at least one round`));
  }

  for (const [index, roundRaw] of roundsRaw.entries()) {
    const path = `${prefix}schedule.rounds[${index}]`;
    if (!roundRaw || typeof roundRaw !== "object" || Array.isArray(roundRaw)) {
      issues.push(fail("ROUND_SHAPE", `${path} must be an object`));
      continue;
    }
    const roundId = typeof roundRaw.id === "string" ? roundRaw.id.trim() : "";
    if (!ID_RE.test(roundId)) {
      issues.push(fail("ROUND_ID", `${path}.id must match ${ID_RE}`));
      continue;
    }
    if (roundIds.has(roundId)) {
      issues.push(fail("ROUND_DUPLICATE", `${path}.id duplicates earlier round ${roundId}`));
      continue;
    }
    roundIds.add(roundId);

    const window = parseRoundWindow(
      { startsAt: roundRaw.startsAt, endsAt: roundRaw.endsAt },
      timeZone,
      { path },
    );
    issues.push(...window.issues);
    const startsAtInstant = window.startsAtInstant;
    const endsAtInstant = window.endsAtInstant;

    const mapPoolId = typeof roundRaw.mapPoolId === "string" ? roundRaw.mapPoolId.trim() : "";
    if (!mapPools[mapPoolId]) {
      issues.push(fail("ROUND_POOL_MISSING", `${path}.mapPoolId does not exist`, { mapPoolId }));
    }

    const winnerCondition =
      typeof roundRaw.winnerCondition === "string" && roundRaw.winnerCondition.trim()
        ? roundRaw.winnerCondition.trim()
        : "score";
    if (winnerCondition !== "score") {
      issues.push(notice("ROUND_WINNER_CONDITION", `${path}.winnerCondition ${winnerCondition} uses score semantics`));
    }

    const effects = [];
    for (const [effectIndex, effect] of readArray(roundRaw.effects, `${path}.effects`, issues).entries()) {
      const eps = `${path}.effects[${effectIndex}]`;
      if (!effect || typeof effect !== "object" || !ROUND_EFFECT_KINDS.has(effect.kind)) {
        issues.push(fail("EFFECT_KIND", `${eps}.kind must be scoring|map|ability`));
        continue;
      }
      if (effect.kind === "scoring") {
        if (!Number.isFinite(effect.multiplier) || effect.multiplier <= 0) {
          issues.push(fail("EFFECT_MULTIPLIER", `${eps}.multiplier must be a positive finite number`));
          continue;
        }
        effects.push({ kind: "scoring", multiplier: effect.multiplier, label: String(effect.label ?? "activity") });
      } else if (effect.kind === "map") {
        const allow = uniqueSorted(readStringList(effect.allow, `${eps}.allow`, issues));
        const deny = uniqueSorted(readStringList(effect.deny, `${eps}.deny`, issues));
        const require = uniqueSorted(readStringList(effect.require, `${eps}.require`, issues));
        if (allow.length === 0 && deny.length === 0 && require.length === 0) {
          issues.push(fail("EFFECT_MAP_EMPTY", `${eps} must set allow, deny, or require`));
          continue;
        }
        effects.push({ kind: "map", allow, deny, require, label: String(effect.label ?? "map-restriction") });
      } else {
        const allow = uniqueSorted(readStringList(effect.allow, `${eps}.allow`, issues));
        const deny = uniqueSorted(readStringList(effect.deny, `${eps}.deny`, issues));
        if (allow.length === 0 && deny.length === 0) {
          issues.push(fail("EFFECT_ABILITY_EMPTY", `${eps} must set allow or deny`));
          continue;
        }
        effects.push({ kind: "ability", allow, deny, label: String(effect.label ?? "ability-restriction") });
      }
    }

    const abilityOverridesRaw = roundRaw.abilityOverrides;
    let abilityOverrides = { defaultAllowed: null, allow: [], deny: [] };
    if (abilityOverridesRaw !== undefined) {
      if (!abilityOverridesRaw || typeof abilityOverridesRaw !== "object" || Array.isArray(abilityOverridesRaw)) {
        issues.push(fail("ROUND_ABILITY_SHAPE", `${path}.abilityOverrides must be an object`));
      } else {
        abilityOverrides = {
          defaultAllowed:
            abilityOverridesRaw.defaultAllowed === undefined ? null : Boolean(abilityOverridesRaw.defaultAllowed),
          allow: uniqueSorted(readStringList(abilityOverridesRaw.allow, `${path}.abilityOverrides.allow`, issues)),
          deny: uniqueSorted(readStringList(abilityOverridesRaw.deny, `${path}.abilityOverrides.deny`, issues)),
        };
      }
    }
    const requiredAbilities = uniqueSorted(
      readStringList(roundRaw.requiresAbilities, `${path}.requiresAbilities`, issues),
    );

    const meta = { name: typeof roundRaw.name === "string" ? roundRaw.name : roundId };
    if (roundRaw.slots !== undefined) {
      if (!Number.isInteger(roundRaw.slots) || roundRaw.slots <= 0) {
        issues.push(fail("ROUND_SLOTS", `${path}.slots must be a positive integer`));
      } else {
        meta.slots = roundRaw.slots;
      }
    }

    rounds.push({
      id: roundId,
      startsAt: roundRaw.startsAt,
      endsAt: roundRaw.endsAt ?? null,
      startsAtInstant,
      endsAtInstant,
      mapPoolId,
      winnerCondition,
      effects,
      abilityOverrides,
      requiresAbilities: requiredAbilities,
      meta,
    });
  }

  // ---- reference integrity (resource constraints) ----------------------
  const missing = collectMissingReferences({ mapPools, abilities, rounds, catalog: sourceCatalog });
  const missingIssue = missingReferenceIssue(missing, { catalogDigest: sourceCatalogDigest, prefix });
  if (missingIssue) issues.push(missingIssue);

  // ---- tag coverage ----------------------------------------------------
  // An unreferenced catalog tag is informational only; it is never an error.
  const referencedTags = new Set();
  const noteTags = (section, ids) => {
    for (const contentId of ids) {
      const definition = lookupDefinition(sourceCatalog, section, contentId);
      for (const tag of definition?.tags ?? []) referencedTags.add(tag);
    }
  };
  for (const pool of Object.values(mapPools)) noteTags("maps", pool.maps);
  noteTags("abilities", abilities.allow);
  noteTags("abilities", abilities.deny);
  for (const round of rounds) {
    noteTags("abilities", round.abilityOverrides.allow);
    noteTags("abilities", round.abilityOverrides.deny);
    noteTags("abilities", round.requiresAbilities);
  }
  for (const category of scoringCategories) referencedTags.add(category);

  // ---- defaults / base rules outside rounds ---------------------------
  const defaultsRaw = raw.defaults ?? {};
  let defaults = { mapPoolId: null };
  if (defaultsRaw !== null && (typeof defaultsRaw !== "object" || Array.isArray(defaultsRaw))) {
    issues.push(fail("DEFAULTS_SHAPE", `${prefix}defaults must be an object`));
  } else if (defaultsRaw?.mapPoolId !== undefined && defaultsRaw.mapPoolId !== null) {
    if (typeof defaultsRaw.mapPoolId !== "string" || !mapPools[defaultsRaw.mapPoolId]) {
      issues.push(fail("DEFAULTS_POOL", `${prefix}defaults.mapPoolId must name a declared pool`));
    } else {
      defaults = { mapPoolId: defaultsRaw.mapPoolId };
    }
  }

  // ---- playable sets (resource constraints) ----------------------------
  // Packages are publish-time validated, and the runtime resolves stacks with
  // the same functions used here.
  const baseCore = {
    schedule: { rounds },
    mapPool: mapPools,
    abilities,
    composition,
  };
  issues.push(...checkPlayableSets({ rounds, core: baseCore, catalog: sourceCatalog, prefix }));

  // ---- overlap / exclusivity / precedence -------------------------------
  // Any window pair that can be simultaneously active must be either excluded
  // or deterministically resolved; otherwise the package would have match-time
  // behaviour that depends on which round happens to be evaluated first, so
  // assembly refuses it.
  const exclusionSet = new Set(composition.exclusions.map((pair) => `${pair.a}|${pair.b}`));
  const isExcluded = (a, b) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return exclusionSet.has(`${x}|${y}`);
  };

  for (const pair of composition.exclusions) {
    for (const roundId of [pair.a, pair.b]) {
      if (!roundIds.has(roundId)) {
        issues.push(fail("COMPOSITION_EXCLUSION_UNKNOWN", `${prefix}excluded round ${roundId} does not exist`));
      }
    }
  }
  for (const roundId of composition.priority) {
    if (!roundIds.has(roundId)) {
      issues.push(fail("COMPOSITION_PRIORITY_UNKNOWN", `${prefix}priority round ${roundId} does not exist`));
    }
  }

  const windows = rounds
    .filter((round) => round.startsAtInstant !== null)
    .map((round) => ({ round, window: { start: round.startsAtInstant, end: round.endsAtInstant ?? Infinity } }));

  let overlapCount = 0;
  let supersededCount = 0;
  let blockedCount = 0;
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i].round;
      const b = windows[j].round;
      if (!roundsOverlap(a, b)) continue;
      overlapCount += 1;
      if (isExcluded(a.id, b.id)) {
        blockedCount += 1;
        issues.push(
          notice("ROUND_OVERLAP_BLOCKED", `${prefix}rounds ${a.id} and ${b.id} overlap and are mutually exclusive`, {
            rounds: [a.id, b.id],
            resolution: "excluded",
          }),
        );
        continue;
      }
      const resolution = stackResolution(baseCore, [a, b]);
      if (!resolution.compatible) {
        issues.push(
          fail("ROUND_OVERLAP_UNRESOLVED", `${prefix}rounds overlap without deterministic precedence`, {
            rounds: [a.id, b.id],
            reason: resolution.reason,
            precedence: composition.precedence,
            hint:
              "declare composition.priority with precedence=declared, or list the pair in composition.exclusions",
          }),
        );
        continue;
      }
      const winner = resolution.winners[0];
      supersededCount += 1;
      issues.push(
        notice("ROUND_OVERLAP_SUPERSEDED", `${prefix}overlapping rounds resolve to ${winner?.id ?? "none"}`, {
          rounds: [a.id, b.id],
          winner: winner?.id ?? null,
          precedence: composition.precedence,
        }),
      );
    }
  }

  // ---- schedule gaps (schedule layer) ----------------------------------
  const analysis = analyzeSchedule(rounds, {
    timeZone,
    hasFallbackPool: defaults.mapPoolId !== null,
    prefix,
  });
  issues.push(...analysis.issues);
  const gaps = analysis.gaps;
  const coverage = analysis.coverage;

  const summaryInputs = summarizeInputs({
    rounds,
    mapPools,
    timeZone,
    defaults,
    scoringBase,
    perMapBonus,
    scoringCategories,
    abilities,
    composition,
    catalogDigest: sourceCatalogDigest,
  });

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  const normalizedCore = {
    id,
    publishedAt: publishedAt !== null ? new Date(publishedAt).toISOString() : null,
    timeZone,
    schedule: {
      rounds: rounds.map((round) => ({
        id: round.id,
        startsAt: round.startsAt,
        endsAt: round.endsAt ?? null,
        startsAtInstant: round.startsAtInstant !== null ? new Date(round.startsAtInstant).toISOString() : null,
        endsAtInstant: round.endsAtInstant !== null ? new Date(round.endsAtInstant).toISOString() : null,
        mapPoolId: round.mapPoolId,
        winnerCondition: round.winnerCondition,
        effects: round.effects,
        abilityOverrides: round.abilityOverrides,
        requiresAbilities: round.requiresAbilities,
        meta: round.meta,
      })),
    },
    defaults,
    mapPool: mapPools,
    scoring: { base: scoringBase, perMapBonus, categories: scoringCategories },
    abilities,
    composition,
    catalogDigest: sourceCatalogDigest,
  };

  return {
    ok: errors.length === 0,
    core: normalizedCore,
    rounds,
    catalog: sourceCatalog,
    catalogDigest: sourceCatalogDigest,
    errors,
    warnings,
    summaryInputs,
    referencedTags: [...referencedTags].sort(),
    missing,
    overlap: { pairs: overlapCount, superseded: supersededCount, blocked: blockedCount },
    gaps: gaps.length,
    gapDetails: gaps,
    coverage,
  };
}

export function diffInputs(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes = [];
  for (const key of [...keys].sort()) {
    if ((before?.[key] ?? null) !== (after?.[key] ?? null)) {
      changes.push({ input: key, from: before?.[key] ?? null, to: after?.[key] ?? null });
    }
  }
  return changes;
}

export { difference, uniqueSorted };
