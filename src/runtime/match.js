import { scoringMultiplier } from "./rules.js";
import { RulePackageView } from "./view.js";
import { PackageError } from "./package.js";
import { fingerprint, canonicalJson, deepFreeze } from "../fingerprint.js";
import { formatLocal } from "../time/civil.js";

/**
 * Pin a package to a match by identity digest. The pin carries the exact
 * frozen content (package + catalog) the match will execute against; it is
 * itself frozen, so nothing the match does can rewrite its own rules.
 */
export function pinPackage(entry) {
  return deepFreeze({
    version: entry.version,
    digest: entry.digest,
    packageId: entry.pkg.id,
    timeZone: entry.pkg.timeZone,
    title: entry.displayName,
    summary: entry.summary ?? null,
    core: entry.pkg,
    catalog: entry.catalog,
    catalogDigest: entry.catalogDigest,
    effectiveFrom: entry.effectiveFrom,
    pinFingerprint: fingerprint(canonicalJson(entry.pkg)),
  });
}

export function verifyPin(pin) {
  const actual = fingerprint(canonicalJson(pin.core));
  if (actual !== pin.pinFingerprint) {
    return {
      ok: false,
      code: "MATCH_PIN_TAMPERED",
      message: `match pin for ${pin.packageId} no longer matches its frozen content`,
      expected: pin.pinFingerprint,
      actual,
    };
  }
  return { ok: true };
}

/**
 * In-match adjudication. The match state is authoritative for scoring: points
 * are added to the match's own ledger as reported, and the rule package only
 * ever explains future scoring. A version released mid-match therefore cannot
 * retroactively alter results. All rule questions go through the read-only
 * RulePackageView built from the pin.
 */
export class Match {
  constructor({ matchId, pin, view = null, createdAt, now, basePoints, roundId = null, roundRules = null, events = [], mapRules = null }) {
    const verified = verifyPin(pin);
    if (!verified.ok) throw new PackageError(verified.code, verified.message, verified);
    this.matchId = matchId;
    this.pin = pin;
    this.view = view ?? new RulePackageView({ pkg: pin.core, catalog: pin.catalog, version: pin.version, digest: pin.digest });
    this.createdAt = createdAt;
    this.createdAtLocal = formatLocal(createdAt, pin.timeZone);
    this.pinnedTo = pin.digest;
    this.mapRules = mapRules ? deepFreeze({ ...mapRules }) : null;
    this.basePoints = basePoints;
    this.roundId = roundId;
    this.roundRules = roundRules
      ? deepFreeze({ rounds: [...roundRules.rounds], resolution: roundRules.resolution })
      : null;
    this.scores = { a: 0, b: 0 };
    this.events = [];
    this.status = "live";
    for (const event of events) this.record(event, { now });
  }

  /**
   * Round rules in effect for this match: a round boundary does not move an
   * already-created match. The match's round binding is fixed at creation.
   */
  effectiveRound() {
    if (this.roundRules) return this.roundRules;
    const resolved = this.view.resolutionAt(this.createdAt);
    return { rounds: resolved.rounds ?? [], resolution: resolved.resolution };
  }

  rulesView() {
    const round = this.effectiveRound();
    const winner = round?.resolution?.winners?.[0] ?? null;
    const mapRules = this.mapRules ?? (winner ? this.view.mapRulesFor(winner) : this.view.baseMapRules());
    const abilities = this.view.abilitiesFor(winner ?? null);
    const multiplier = round
      ? this.view.multiplierFor(round.resolution.compatible ? round.resolution.winners : round.rounds)
      : { multiplier: 1, stacking: { compatible: true, reason: null }, contributors: [], effect: "base" };
    return {
      roundId: winner?.id ?? null,
      activeRounds: (round?.rounds ?? []).map((entry) => entry.id),
      stacking: round?.resolution ?? null,
      mapRules,
      allowedAbilities: abilities,
      allowedMaps: mapRules.allowedMaps,
      defaultMap: mapRules.defaultMap,
      multiplier: multiplier.multiplier,
      winnerCondition: winner?.winnerCondition ?? null,
      packageDigest: this.pin.digest,
      packageVersion: this.pin.version,
    };
  }

  /**
   * Report a map result. Scoring state is committed to the match ledger at
   * report time using the match's pinned package; it is never recomputed from
   * whatever package happens to be current later.
   */
  record(event, { now } = {}) {
    if (this.status !== "live") {
      throw new PackageError("MATCH_CLOSED", `match ${this.matchId} is ${this.status}`);
    }
    if (!event || typeof event !== "object") {
      throw new PackageError("MATCH_EVENT_SHAPE", "match event must be an object");
    }
    const at = now ?? event.at ?? this.createdAt;
    if (event.kind !== "map-result") {
      throw new PackageError("MATCH_EVENT_KIND", `unsupported match event ${event.kind}`);
    }
    if (event.side !== "a" && event.side !== "b") {
      throw new PackageError("MATCH_EVENT_SIDE", `map-result side must be a or b`);
    }
    const view = this.rulesView();
    if (!view.mapRules.valid) {
      throw new PackageError("MATCH_MAP_RULES_INVALID", `match ${this.matchId} has no playable map rules`, {
        reason: view.mapRules.reason,
      });
    }
    if (!view.allowedMaps.includes(event.mapId)) {
      throw new PackageError("MATCH_MAP_NOT_ALLOWED", `map ${event.mapId} is not allowed by the pinned rules`, {
        mapId: event.mapId,
        allowedMaps: view.allowedMaps,
      });
    }
    if (event.abilityId !== undefined && !view.allowedAbilities.includes(event.abilityId)) {
      throw new PackageError("MATCH_ABILITY_NOT_ALLOWED", `ability ${event.abilityId} is not allowed by the pinned rules`, {
        abilityId: event.abilityId,
        allowedAbilities: view.allowedAbilities,
      });
    }
    const scoring = scoringMultiplier(
      this.pin.core,
      view.roundId ? (view.stacking?.winners ?? this.view.activeRoundsAt(this.createdAt)) : [],
    );
    if (!scoring.stacking.compatible) {
      throw new PackageError("MATCH_STACK_BLOCKED", `pinned rules block the overlap of ${view.activeRounds.join(", ")}`, {
        reason: scoring.stacking.reason,
      });
    }
    const base = event.basePoints ?? this.basePoints ?? this.pin.core.scoring.base;
    const bonus = this.pin.core.scoring.perMapBonus[event.mapId] ?? 0;
    const points = Number((base * scoring.multiplier + bonus).toFixed(2));
    this.scores[event.side] = Number((this.scores[event.side] + points).toFixed(2));
    const record = {
      seq: this.events.length + 1,
      at,
      atLocal: formatLocal(at, this.pin.timeZone),
      kind: event.kind,
      side: event.side,
      mapId: event.mapId,
      abilityId: event.abilityId ?? null,
      basePoints: base,
      multiplier: scoring.multiplier,
      perMapBonus: bonus,
      points,
      multiplierSource: scoring.effect,
      contributingRounds: scoring.contributors,
      packageVersion: this.pin.version,
      packageDigest: this.pin.digest,
    };
    this.events.push(Object.freeze(record));
    return record;
  }

  close({ outcome = "final" } = {}) {
    if (this.status === "live") this.status = outcome;
    return this.status;
  }
}
