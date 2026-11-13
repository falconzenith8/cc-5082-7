import { ScheduleView } from "../time/schedule.js";
import {
  stackResolution,
  scoringMultiplier,
  effectiveMapRules,
  baseMapRules,
  effectiveAbilities,
} from "./rules.js";
import { deepFreeze } from "../fingerprint.js";

/**
 * Read-only runtime interface over one frozen rule package plus its catalog.
 *
 * Every query takes an explicit instant (ms); the view holds no clock and no
 * mutable state of its own. Resolution results are computed once per
 * (instant, roundId) pair, frozen, and cached — safe because the wrapped
 * package is sealed and deep-frozen by the composition layer, so a cached
 * answer can never go stale. Two views built from different digests never
 * share cache entries: the cache lives on the view instance.
 */
export class RulePackageView {
  #core;
  #catalog;
  #schedule;
  #resolutionCache = new Map();
  #snapshotCache = new Map();

  constructor({ pkg, catalog, version = null, digest = null, displayName = null }) {
    this.version = version;
    this.digest = digest ?? pkg.identity?.digest ?? null;
    this.packageId = pkg.id;
    this.timeZone = pkg.timeZone;
    this.displayName = displayName ?? null;
    this.#core = pkg;
    this.#catalog = catalog;
    this.#schedule = new ScheduleView(pkg.schedule?.rounds ?? []);
    Object.freeze(this);
  }

  /** The frozen package content. Callers must not mutate it (it is frozen). */
  get core() {
    return this.#core;
  }

  get catalog() {
    return this.#catalog;
  }

  activeRoundsAt(instant) {
    return this.#schedule.activeAt(instant);
  }

  /**
   * Resolve the active rounds at an instant. Returns a frozen result:
   *   ok:      { status:"ok", rounds, activeRounds, resolution, winner }
   *   blocked: { status:"blocked", reason:"STACK_BLOCKED", rounds, activeRounds, resolution, winner:null }
   *   none:    { status:"none", reason:"ROUND_UNAVAILABLE", activeRounds:[ids] }
   * `rounds` is the selected subset (all active rounds, or the named round);
   * `activeRounds` is always the full active set.
   */
  resolutionAt(instant, { roundId = null } = {}) {
    const key = `${instant}|${roundId ?? ""}`;
    const cached = this.#resolutionCache.get(key);
    if (cached) return cached;

    const all = this.#schedule.activeAt(instant);
    let selected = all;
    if (roundId !== null) {
      const named = all.find((round) => round.id === roundId);
      if (!named) {
        const unavailable = deepFreeze({
          status: "none",
          reason: "ROUND_UNAVAILABLE",
          activeRounds: all.map((round) => round.id),
        });
        this.#resolutionCache.set(key, unavailable);
        return unavailable;
      }
      selected = [named];
    }
    const resolution = stackResolution(this.#core, selected);
    const result = deepFreeze({
      status: resolution.compatible ? "ok" : "blocked",
      reason: resolution.compatible ? null : "STACK_BLOCKED",
      rounds: selected,
      activeRounds: all,
      resolution,
      winner: resolution.compatible ? (resolution.winners[0] ?? null) : null,
    });
    this.#resolutionCache.set(key, result);
    return result;
  }

  mapRulesFor(round) {
    return effectiveMapRules(this.#core, round);
  }

  baseMapRules() {
    return baseMapRules(this.#core);
  }

  /** Rules of the package default pool, or null when no default pool is set. */
  defaultPoolRules() {
    const poolId = this.#core.defaults?.mapPoolId;
    return poolId ? effectiveMapRules(this.#core, { mapPoolId: poolId, effects: [] }) : null;
  }

  abilitiesFor(round = null) {
    return effectiveAbilities(this.#core, this.#catalog, round);
  }

  multiplierFor(rounds) {
    return scoringMultiplier(this.#core, rounds);
  }

  /**
   * Full rule snapshot at an instant — the shape the online inspection entry
   * reports. Frozen and cached per (instant, roundId).
   */
  rulesAt(instant, { roundId = null } = {}) {
    const key = `${instant}|${roundId ?? ""}`;
    const cached = this.#snapshotCache.get(key);
    if (cached) return cached;

    const resolved = this.resolutionAt(instant, { roundId });
    let snapshot;
    if (resolved.status === "none") {
      snapshot = resolved;
    } else if (resolved.status === "blocked") {
      snapshot = deepFreeze({
        status: "blocked",
        reason: "STACK_BLOCKED",
        roundIds: resolved.activeRounds.map((round) => round.id),
        stacking: resolved.resolution,
      });
    } else {
      const winner = resolved.winner;
      snapshot = deepFreeze({
        status: "ok",
        roundId: winner?.id ?? null,
        activeRounds: resolved.activeRounds.map((round) => round.id),
        winningRound: winner?.id ?? null,
        mapRules: winner ? this.mapRulesFor(winner) : { valid: true, allowedMaps: [], defaultMap: null },
        allowedAbilities: this.abilitiesFor(winner ?? null),
        scoringMultiplier: this.multiplierFor(winner ? [winner] : []).multiplier,
        winnerCondition: winner?.winnerCondition ?? null,
        stacking: resolved.resolution,
      });
    }
    this.#snapshotCache.set(key, snapshot);
    return snapshot;
  }
}
