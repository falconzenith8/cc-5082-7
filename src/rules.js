/**
 * Pure runtime rule resolution. Both assembly-time validation and live match
 * play call these functions, so what the catalog validates is exactly what the
 * runtime executes. Round instants may be epoch milliseconds (in-memory rounds)
 * or ISO strings (serialized packages); both normalize here.
 */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundWindow(round) {
  const start = toMs(round.startsAtInstant ?? round.startMs);
  if (start === null) return null;
  const rawEnd = toMs(round.endsAtInstant ?? round.endMs);
  const end = rawEnd === null ? Infinity : rawEnd;
  return { start, end };
}

export function roundsOverlap(a, b) {
  const wa = roundWindow(a);
  const wb = roundWindow(b);
  if (!wa || !wb) return false;
  return wa.start < wb.end && wb.start < wa.end;
}

export function isRoundActiveAt(round, instant) {
  const window = roundWindow(round);
  if (!window) return false;
  return instant >= window.start && instant < window.end;
}export function activeRoundsAt(core, instant) {
  return core.schedule.rounds.filter((round) => isRoundActiveAt(round, instant));
}

export function effectiveMapRules(core, round) {
  const pool = core.mapPool[round.mapPoolId];
  if (!pool) {
    return { valid: false, reason: "MISSING_POOL", poolId: round.mapPoolId, allowedMaps: [], defaultMap: null };
  }
  let allowed = [...pool.maps];
  for (const effect of round.effects) {
    if (effect.kind !== "map") continue;
    if (effect.allow.length) allowed = allowed.filter((mapId) => effect.allow.includes(mapId));
    if (effect.deny.length) allowed = allowed.filter((mapId) => !effect.deny.includes(mapId));
    if (effect.require.length) allowed = allowed.filter((mapId) => effect.require.includes(mapId));
  }
  allowed = [...new Set(allowed)].sort();
  const defaultMap = allowed.includes(pool.defaultMap) ? pool.defaultMap : allowed[0] ?? null;
  return {
    valid: allowed.length > 0,
    reason: allowed.length > 0 ? null : "NO_PLAYABLE_MAP",
    poolId: round.mapPoolId,
    allowedMaps: allowed,
    defaultMap,
  };
}

export function baseMapRules(core) {
  const poolId = core.defaults?.mapPoolId ?? null;
  const pool = poolId ? core.mapPool[poolId] : null;
  if (!pool) {
    return { valid: false, reason: "NO_DEFAULT_POOL", poolId, allowedMaps: [], defaultMap: null };
  }
  const allowedMaps = [...pool.maps].sort();
  return {
    valid: allowedMaps.length > 0,
    reason: allowedMaps.length > 0 ? null : "NO_PLAYABLE_MAP",
    poolId,
    allowedMaps,
    defaultMap: pool.defaultMap,
  };
}

/**
 * Allowed ability ids for a round, enumerated against the catalog so the result
 * is finite and inspectable.
 *
 * Layers are applied outward-in: package defaults -> package deny -> round
 * overrides -> round effects. A round's ability `allow` list grants those
 * abilities and removes any id still on its `deny` list; it does not narrow an
 * otherwise open package. Explicit denies from any layer always win.
 */
export function effectiveAbilities(core, catalog, round) {
  const allIds = Object.keys(catalog.abilities).sort();
  const base = new Set();
  for (const id of allIds) {
    if (core.abilities.defaultAllowed || core.abilities.allow.includes(id)) base.add(id);
  }
  for (const id of core.abilities.deny) base.delete(id);

  if (!round) return [...base].sort();

  const overrides = round.abilityOverrides ?? { defaultAllowed: null, allow: [], deny: [] };
  let allowed;
  if (overrides.defaultAllowed === true) {
    allowed = new Set(allIds);
  } else if (overrides.defaultAllowed === false) {
    allowed = new Set();
  } else {
    allowed = new Set(base);
  }
  for (const id of overrides.allow) allowed.add(id);
  for (const id of overrides.deny) allowed.delete(id);

  for (const effect of round.effects) {
    if (effect.kind !== "ability") continue;
    for (const id of effect.allow) allowed.add(id);
    for (const id of effect.deny) allowed.delete(id);
  }
  return [...allowed].sort();
}

export function abilityAllowed(core, catalog, round, abilityId) {
  return effectiveAbilities(core, catalog, round).includes(abilityId);
}

export function priorityRank(core) {
  return new Map(core.composition.priority.map((roundId, index) => [roundId, index]));
}

export function orderRounds(core, rounds) {
  const precedence = core.composition.precedence;
  const declared = priorityRank(core);
  const keyed = rounds.map((round, index) => {
    if (precedence === "newest") {
      return { round, index, key: -(round.startsAtInstant ?? round.startMs ?? 0) };
    }
    if (precedence === "oldest") {
      return { round, index, key: round.startsAtInstant ?? round.startMs ?? 0 };
    }
    return { round, index, key: declared.has(round.id) ? declared.get(round.id) : declared.size + index };
  });
  keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key));
  return keyed.map((entry) => entry.round);
}

/**
 * Determine whether two or more simultaneously active rounds are allowed to
 * stack. Returns { compatible, winners, ties, reason }.
 *
 * combine=multiply stacks every active round, so exclusivity is only about
 * declared exclusions. combine=exclusive picks exactly one provider: with
 * precedence=declared the highest-priority active round wins outright; with
 * newest/oldest the newest/oldest start wins. Equal-start rounds with no
 * tie-break and no priority declaration are an unresolved tie and are refused.
 */
export function stackResolution(core, activeRounds) {
  if (activeRounds.length === 0) {
    return { compatible: true, winners: [], ties: [], reason: null };
  }
  if (activeRounds.length === 1) {
    return { compatible: true, winners: activeRounds, ties: [], reason: null };
  }
  const ids = activeRounds.map((round) => round.id);
  for (const pair of core.composition.exclusions) {
    if (ids.includes(pair.a) && ids.includes(pair.b)) {
      return {
        compatible: false,
        winners: [],
        ties: [],
        reason: "EXCLUDED_PAIR",
        pair,
      };
    }
  }
  if (core.composition.combine === "multiply") {
    return { compatible: true, winners: activeRounds, ties: [], reason: null };
  }

  const precedence = core.composition.precedence;
  if (precedence === "declared") {
    const ordered = orderRounds(core, activeRounds);
    const ranked = ordered.filter((round) => priorityRank(core).has(round.id));
    if (ranked.length > 0) {
      const top = ranked[0];
      const tied = ranked.filter(
        (round) =>
          round.id !== top.id &&
          priorityRank(core).get(round.id) === priorityRank(core).get(top.id),
      );
      if (tied.length && !core.composition.allowTies) {
        return { compatible: false, winners: [], ties: [top, ...tied], reason: "UNRESOLVED_TIE" };
      }
      return {
        compatible: true,
        winners: core.composition.allowTies ? [top, ...tied] : [top],
        ties: tied,
        reason: null,
      };
    }
    return { compatible: false, winners: [], ties: activeRounds, reason: "UNDECLARED_PRIORITY" };
  }

  const ordered = orderRounds(core, activeRounds);
  const top = ordered[0];
  const tied = ordered.filter(
    (round) => round.id !== top.id && sameRank(core, round, top),
  );
  if (tied.length && !core.composition.allowTies) {
    return {
      compatible: false,
      winners: [],
      ties: [top, ...tied],
      reason: "UNRESOLVED_TIE",
    };
  }
  const winners = core.composition.allowTies ? [top, ...tied] : [top];
  return { compatible: true, winners, ties: tied, reason: null };
}

function sameRank(core, a, b) {
  const precedence = core.composition.precedence;
  if (precedence === "newest" || precedence === "oldest") {
    return (a.startsAtInstant ?? a.startMs) === (b.startsAtInstant ?? b.startMs);
  }
  return priorityRank(core).get(a.id) === priorityRank(core).get(b.id);
}

export function scoringEffectsOf(round) {
  return round.effects.filter((effect) => effect.kind === "scoring");
}

export function scoringMultiplier(core, activeRounds) {
  const stacking = stackResolution(core, activeRounds);
  if (!stacking.compatible) {
    return { multiplier: 1, stacking, contributors: [], effect: "none" };
  }
  const contributors = stacking.winners.filter((round) => scoringEffectsOf(round).length > 0);
  if (contributors.length === 0) {
    return { multiplier: 1, stacking, contributors: [], effect: "base" };
  }
  if (core.composition.combine === "multiply") {
    const multiplier = contributors.reduce(
      (product, round) =>
        product * scoringEffectsOf(round).reduce((inner, effect) => inner * effect.multiplier, 1),
      1,
    );
    return { multiplier, stacking, contributors: contributors.map((round) => round.id), effect: "multiply" };
  }
  const factors = contributors.flatMap((round) =>
    scoringEffectsOf(round).map((effect) => effect.multiplier),
  );
  const multiplier = factors.length ? Math.max(...factors) : 1;
  return {
    multiplier,
    stacking,
    contributors: contributors.map((round) => round.id),
    effect: "exclusive",
  };
}

export function scoreMapOutcome(core, activeRounds, { mapId, basePoints }) {
  const scoring = scoringMultiplier(core, activeRounds);
  const computedBase = basePoints ?? core.scoring.base;
  const bonus = core.scoring.perMapBonus[mapId] ?? 0;
  const points = computedBase * scoring.multiplier + bonus;
  return {
    mapId,
    basePoints: computedBase,
    multiplier: scoring.multiplier,
    perMapBonus: bonus,
    rawPoints: points,
    points: Number(points.toFixed(2)),
    multiplierSource: scoring.effect,
    contributingRounds: scoring.contributors,
    stacking: scoring.stacking,
  };
}

