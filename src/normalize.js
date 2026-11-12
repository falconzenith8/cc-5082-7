import { fingerprint } from "./fingerprint.js";
import { PackageError, sealPackage } from "./package.js";
import { isValidTimeZone, parseWhen, civilIso } from "./time.js";
import { normalizeCatalog, lookupDefinition } from "./catalog.js";
import { roundsOverlap, stackResolution, effectiveAbilities, effectiveMapRules } from "./rules.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRECEDENCE = new Set(["newest", "oldest", "declared"]);
const COMBINE = new Set(["exclusive", "multiply"]);
const ROUND_EFFECT_KINDS = new Set(["scoring", "map", "ability"]);

const fail = (code, message, details = {}) => ({ severity: "error", code, message, details });
const notice = (code, message, details = {}) => ({ severity: "warning", code, message, details });

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

    const starts = parseWhen(roundRaw.startsAt, timeZone);
    let startsAtInstant = starts.instant;
    if (starts.status === "nonexistent") {
      issues.push(fail("ROUND_START_NONEXISTENT", `${path}.startsAt does not exist in ${timeZone}`, { local: starts.civil }));
    } else if (starts.status === "ambiguous") {
      issues.push(notice("ROUND_START_AMBIGUOUS", `${path}.startsAt occurs twice in ${timeZone}; earliest kept`, {
        local: starts.civil,
        candidates: starts.candidates.map((instant) => new Date(instant).toISOString()),
      }));
    } else if (starts.status !== "ok") {
      issues.push(fail("ROUND_START_INVALID", `${path}.startsAt is invalid`, { status: starts.status }));
    }

    let endsAtInstant = null;
    if (roundRaw.endsAt !== undefined && roundRaw.endsAt !== null) {
      const ends = parseWhen(roundRaw.endsAt, timeZone);
      if (ends.status === "nonexistent") {
        issues.push(fail("ROUND_END_NONEXISTENT", `${path}.endsAt does not exist in ${timeZone}`, { local: ends.civil }));
      } else if (ends.status === "ambiguous") {
        issues.push(notice("ROUND_END_AMBIGUOUS", `${path}.endsAt occurs twice in ${timeZone}; earliest kept`, {
          local: ends.civil,
        }));
      } else if (ends.status !== "ok") {
        issues.push(fail("ROUND_END_INVALID", `${path}.endsAt is invalid`, { status: ends.status }));
      } else {
        endsAtInstant = ends.instant;
        if (startsAtInstant !== null && endsAtInstant <= startsAtInstant) {
          issues.push(fail("ROUND_END_ORDER", `${path}.endsAt must be after startsAt`));
        }
      }
    }

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

  // ---- reference integrity --------------------------------------------
  const missing = [];
  const catalogMaps = new Set(Object.keys(sourceCatalog.maps));
  const catalogAbilities = new Set(Object.keys(sourceCatalog.abilities));
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
  if (missing.length) {
    issues.push(
      fail("RESOURCE_REFERENCE_MISSING", `${prefix}package references content that is not defined`, {
        missing,
        catalogDigest: sourceCatalogDigest,
      }),
    );
  }

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

  // ---- overlap / exclusivity / precedence -------------------------------
  // Packages are publish-time validated, and the runtime resolves stacks with
  // the same functions used here. Any window pair that can be simultaneously
  // active must be either excluded or deterministically resolved; otherwise the
  // package would have match-time behaviour that depends on which round happens
  // to be evaluated first, so assembly refuses it.
  const baseCore = {
    schedule: { rounds },
    mapPool: mapPools,
    abilities,
    composition,
  };

  // A round whose effective ability set collapses to empty, or whose effective
  // map set collapses to empty, cannot host a match; refuse it now rather than
  // failing at match creation time.
  for (const round of rounds) {
    const allowedAbilities = effectiveAbilities(baseCore, sourceCatalog, round);
    if (Object.keys(sourceCatalog.abilities).length > 0 && allowedAbilities.length === 0) {
      issues.push(
        fail("ABILITY_SET_EMPTY", `${prefix}round ${round.id} leaves no usable ability`, {
          roundId: round.id,
        }),
      );
    }
    const mapRules = effectiveMapRules(baseCore, round);
    if (mapRules.valid !== true && mapRules.reason === "NO_PLAYABLE_MAP") {
      issues.push(
        fail("MAP_SET_EMPTY", `${prefix}round ${round.id} leaves no playable map after restrictions`, {
          roundId: round.id,
          poolId: mapRules.poolId,
        }),
      );
    }
  }

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

  // ---- schedule gaps ---------------------------------------------------
  let gapCount = 0;
  const gaps = [];
  const ordered = rounds
    .filter((round) => round.startsAtInstant !== null && round.endsAtInstant !== null)
    .sort((a, b) => a.startsAtInstant - b.startsAtInstant || a.id.localeCompare(b.id));
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const current = ordered[i];
    const next = ordered[i + 1];
    if (next.startsAtInstant > current.endsAtInstant) {
      gapCount += 1;
      const gap = {
        afterRound: current.id,
        beforeRound: next.id,
        gapStart: new Date(current.endsAtInstant).toISOString(),
        gapEnd: new Date(next.startsAtInstant).toISOString(),
        gapStartLocal: civilIso(current.endsAtInstant, timeZone),
        gapEndLocal: civilIso(next.startsAtInstant, timeZone),
        coveredByDefaultPool: defaults.mapPoolId !== null,
      };
      gaps.push(gap);
      issues.push(notice("SCHEDULE_GAP", `${prefix}no round covers the gap after ${current.id}`, gap));
      if (defaults.mapPoolId === null) {
        issues.push(
          notice("SCHEDULE_GAP_NO_FALLBACK", `${prefix}gap after ${current.id} has no defaults.mapPoolId fallback`, {
            afterRound: current.id,
            beforeRound: next.id,
          }),
        );
      }
    }
    if (next.startsAtInstant < current.endsAtInstant) {
      issues.push(
        notice("ROUND_WINDOW_OVERLAP", `${prefix}round ${next.id} starts before ${current.id} ends`, {
          rounds: [current.id, next.id],
        }),
      );
    }
  }

  const openEnded = rounds.filter((round) => round.startsAtInstant !== null && round.endsAtInstant === null);
  const coverage = {
    earliest: ordered.length ? ordered[0].startsAtInstant : null,
    latest: ordered.length ? ordered[ordered.length - 1].endsAtInstant : null,
    openEnded: openEnded.map((round) => round.id),
    gaps: gaps.length,
    hasFallbackPool: defaults.mapPoolId !== null,
  };

  const summaryInputs = {
    schedule: scheduleInputDigest(rounds, mapPools, timeZone),
    defaults: fingerprint(defaults),
    mapPool: fingerprint(mapPools),
    scoring: fingerprint({ base: scoringBase, perMapBonus, categories: scoringCategories }),
    abilities: fingerprint(abilities),
    composition: fingerprint(composition),
    catalogDigest: sourceCatalogDigest,
  };

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
    gaps: gapCount,
    gapDetails: gaps,
    coverage,
  };
}

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

/**
 * Assemble (and seal) a package only when it is fully usable. Refusal is a
 * first-class result: callers receive diagnostics plus the exact refusal reason
 * codes, and no sealed package is produced.
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
  const sealed = sealPackage(normalized.core);
  return {
    status: "assembled",
    package: sealed,
    catalog: normalized.catalog,
    catalogDigest: normalized.catalogDigest,
    errors: [],
    warnings: normalized.warnings,
    referencedTags: normalized.referencedTags,
    summaryInputs: normalized.summaryInputs,
    rounds: normalized.rounds,
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
