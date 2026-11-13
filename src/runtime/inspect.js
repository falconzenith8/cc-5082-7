import { parseWhen, formatLocal } from "../time/civil.js";
import { RulePackageView } from "./view.js";

/**
 * Resolve rules for an already-assembled package at an instant, without any
 * store or match. Used by the CLI `inspect` command and by offline tooling.
 * Unlike the online inspection entry, an instant with no active round falls
 * back to the package default pool and reports it as blocked when unusable.
 */
export function inspectAssembledPackage(assembled, when, { roundId = null } = {}) {
  const parsed = parseWhen(when, assembled.package.timeZone);
  if (parsed.status !== "ok") {
    return { status: "none", reason: "INVALID_INSTANT", detail: parsed };
  }
  const core = assembled.package;
  const view = new RulePackageView({ pkg: core, catalog: assembled.catalog });
  const resolved = view.resolutionAt(parsed.instant, { roundId });
  if (resolved.status === "none") {
    return { status: "none", reason: "ROUND_UNAVAILABLE", activeRounds: resolved.activeRounds };
  }
  if (resolved.status === "blocked") {
    return {
      status: "blocked",
      reason: "STACK_BLOCKED",
      roundIds: resolved.rounds.map((round) => round.id),
      stacking: resolved.resolution,
      version: null,
      digest: core.identity.digest,
    };
  }
  const winner = resolved.winner;
  const mapRules = winner ? view.mapRulesFor(winner) : view.baseMapRules();
  if (!mapRules.valid) {
    return {
      status: "blocked",
      reason: winner ? "NO_PLAYABLE_MAP" : "NO_FALLBACK_POOL",
      roundIds: resolved.rounds.map((round) => round.id),
      mapRules,
      digest: core.identity.digest,
    };
  }
  return {
    status: "ok",
    version: null,
    digest: core.identity.digest,
    instant: parsed.instant,
    instantLocal: formatLocal(parsed.instant, core.timeZone),
    roundId: winner?.id ?? null,
    winningRound: winner?.id ?? null,
    activeRounds: resolved.rounds.map((round) => round.id),
    mapRules,
    allowedAbilities: view.abilitiesFor(winner),
    scoringMultiplier: view.multiplierFor(winner ? [winner] : []).multiplier,
    winnerCondition: winner?.winnerCondition ?? null,
    stacking: resolved.resolution,
  };
}
