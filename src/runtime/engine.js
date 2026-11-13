import { RulePackageStore, explainSelection } from "./store.js";
import { Match, pinPackage, verifyPin } from "./match.js";
import { RulePackageView } from "./view.js";
import { requireTimeSource } from "../time/clock.js";
import { parseWhen, formatLocal } from "../time/civil.js";
import { PackageError } from "./package.js";
import { canonicalJson, shortDigest, deepFreeze } from "../fingerprint.js";
import { buildTimeline } from "./timeline.js";

/**
 * Engine facade: publication, selection by creation time, parallel matches,
 * rollback, and time skipping. No wall-clock reads; every decision takes an
 * explicit instant supplied by the injected time source or the caller.
 *
 * Two kinds of methods:
 *   commands (publish, startMatch, reportResult, skipTo, rollback) mutate
 *     engine/match/clock state;
 *   queries (selectAt, inspectRulesAt, observations, compareObservations,
 *     stateAt, timeline) are read-only: they return frozen snapshots and never
 *     hand out a mutable reference to the rule objects live matches execute
 *     against.
 */
export class SeasonEngine {
  constructor({ store, timeSource, catalog = null } = {}) {
    this.timeSource = requireTimeSource(timeSource);
    this.store = store ?? new RulePackageStore({ catalog });
    this.matches = new Map();
    this.refusals = [];
    this.history = [];
  }

  publish(candidate, opts = {}) {
    const result = this.store.publish(candidate, { now: this.timeSource.now(), ...opts });
    if (result.status === "refused") {
      this.refusals.push(Object.freeze({ at: this.timeSource.now(), stage: result.stage, result }));
      return result;
    }
    if (result.status === "duplicate") return result;
    this.history.push({
      kind: "publish",
      at: this.timeSource.now(),
      version: result.version,
      digest: result.digest,
    });
    return result;
  }

  /**
   * Select the package at the match's creation instant. This is the only package
   * the match will ever use: `selectAt` is evaluated once, and the result is a
   * frozen pin, so later publications cannot reach in.
   *
   * Read-only: the returned snapshot is frozen; the store entries it references
   * are frozen at publication time.
   */
  selectAt(when) {
    const parsed = parseWhen(when);
    const instant = parsed.status === "ok" ? parsed.instant : null;
    if (instant === null) {
      return deepFreeze({
        status: "none",
        reason: "INVALID_INSTANT",
        detail: parsed,
      });
    }
    const available = this.store.availableAt(instant);
    if (available.length === 0) {
      return deepFreeze({
        status: "none",
        reason: "NO_PACKAGE_BEFORE_INSTANT",
        instant,
        instantLocal: this.store.head() ? formatLocal(instant, this.store.head().pkg.timeZone) : null,
        earliest: this.store.head()?.effectiveFrom ?? null,
        versions: this.store.versions(),
      });
    }
    const newest = available[0];
    let previous = null;
    for (const entry of available) {
      if (entry.version < newest.version) {
        previous = entry;
        break;
      }
    }
    return deepFreeze({
      status: "selected",
      instant,
      entry: newest,
      version: newest.version,
      digest: newest.digest,
      previousVersion: previous?.version ?? null,
      rolledForwardFrom: previous?.version ?? null,
      pinnedEntry: newest,
    });
  }

  startMatch({ matchId, at, roundId = null, basePoints = null, events = [] }) {
    if (typeof matchId !== "string" || !matchId.trim()) {
      throw new PackageError("MATCH_ID", "matchId is required");
    }
    if (this.matches.has(matchId)) {
      throw new PackageError("MATCH_EXISTS", `match ${matchId} already exists`);
    }
    const when = parseWhen(at);
    if (when.status !== "ok") {
      throw new PackageError("MATCH_START_INVALID", "match start must resolve to an instant", { at, status: when.status });
    }
    const selection = this.selectAt(at);
    if (selection.status !== "selected") {
      throw new PackageError("MATCH_NO_RULES", `no rule package is effective at match creation`, selection);
    }
    const pin = pinPackage(selection.entry);
    const truth = verifyPin(pin);
    if (!truth.ok) throw new PackageError(truth.code, truth.message, truth);

    const view = new RulePackageView({
      pkg: pin.core,
      catalog: pin.catalog,
      version: pin.version,
      digest: pin.digest,
      displayName: pin.title,
    });
    const resolved = view.resolutionAt(when.instant, { roundId });
    if (resolved.status === "none") {
      throw new PackageError("MATCH_ROUND_UNAVAILABLE", `round ${roundId} is not active at ${at}`, {
        activeRounds: resolved.activeRounds,
      });
    }
    if (resolved.status === "blocked") {
      throw new PackageError("MATCH_STACK_BLOCKED", `rounds cannot be combined under the pinned package`, {
        reason: resolved.resolution.reason,
      });
    }
    const winner = resolved.winner;
    const mapRules = winner ? view.mapRulesFor(winner) : null;
    if (winner && !mapRules.valid) {
      throw new PackageError("MATCH_MAP_RULES_INVALID", `round ${winner.id} has no playable maps after restrictions`, {
        reason: mapRules.reason,
      });
    }
    if (!winner) {
      const base = view.defaultPoolRules();
      if (base && !base.valid) {
        throw new PackageError("MATCH_NO_ACTIVE_RULES", `no round is active at ${at} and the package has no usable default pool`, {
          baseMapRules: base,
        });
      }
    }

    const match = new Match({
      matchId,
      pin,
      view,
      createdAt: when.instant,
      now: when.instant,
      basePoints,
      roundRules: { rounds: resolved.rounds, resolution: resolved.resolution },
      mapRules,
      events,
    });
    this.matches.set(matchId, match);
    this.history.push({
      kind: "start",
      at: this.timeSource.now(),
      matchId,
      version: pin.version,
      digest: pin.digest,
      round: winner?.id ?? null,
    });
    return match;
  }

  reportResult(matchId, event) {
    const match = this.requireMatch(matchId);
    const record = match.record(event, { now: this.timeSource.now() });
    return record;
  }

  getMatch(matchId) {
    return this.matches.get(matchId) ?? null;
  }

  requireMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match) throw new PackageError("MATCH_UNKNOWN", `unknown match ${matchId}`);
    return match;
  }

  /** Two (or more) parallel matches observed at the given (or current) instant. Read-only. */
  observations(matchIds, at = this.timeSource.now()) {
    return deepFreeze(
      matchIds.map((matchId) => {
        const match = this.requireMatch(matchId);
        const view = match.rulesView();
        return {
          matchId,
          observedAt: at,
          observedAtLocal: formatLocal(at, match.pin.timeZone),
          packageVersion: match.pin.version,
          packageDigest: match.pin.digest,
          packageDigestShort: shortDigest(match.pin.digest),
          pinnedTo: match.pinnedTo,
          frozenAt: match.createdAt,
          frozenAtLocal: match.createdAtLocal,
          stillUsesPinnedPackage:
            canonicalJson(match.pin.core) === canonicalJson(this.store.get(match.pin.version)?.pkg ?? {}),
          currentPackageVersion: this.store.head()?.version ?? null,
          roundId: view.roundId,
          activeRounds: view.activeRounds,
          scoringMultiplier: view.multiplier,
          allowedMaps: view.allowedMaps,
          allowedAbilities: view.allowedAbilities,
          scores: { ...match.scores },
          events: match.events.map((event) => ({ ...event })),
        };
      }),
    );
  }

  /**
   * Compare two parallel matches field by field so the divergence after a
   * rotation boundary is visible as concrete values, not prose. Read-only.
   */
  compareObservations(matchAId, matchBId, at = this.timeSource.now()) {
    const [a, b] = this.observations([matchAId, matchBId], at);
    const fields = [
      "packageVersion",
      "packageDigest",
      "roundId",
      "scoringMultiplier",
      "allowedMaps",
      "allowedAbilities",
      "scores",
    ];
    const differences = [];
    for (const field of fields) {
      const left = canonicalJson(a[field] ?? null);
      const right = canonicalJson(b[field] ?? null);
      if (left !== right) {
        differences.push({ field, a: a[field], b: b[field] });
      }
    }
    return deepFreeze({
      at,
      a,
      b,
      samePackage: a.packageDigest === b.packageDigest,
      sameRules: differences.length === 0,
      differences,
    });
  }

  /**
   * Time-skip tool. Drives the injected time source forward; refuses when the
   * source is immutable. Returns before/after observations for the matches.
   */
  skipTo(when, { matchIds = [...this.matches.keys()], timeZone } = {}) {
    if (typeof this.timeSource.advanceTo !== "function") {
      throw new PackageError(
        "TIME_SOURCE_IMMUTABLE",
        "the injected time source cannot be driven by skipTo; advance it yourself",
      );
    }
    const before = this.timeSource.now();
    const after = this.timeSource.advanceTo(when, timeZone);
    const observations = this.observations(matchIds, after.to);
    return { before: before, after: after.to, elapsedMs: after.elapsedMs, observations };
  }

  /** Read the rules a match started at `at` would receive without creating it. Read-only. */
  inspectRulesAt(when, { roundId = null } = {}) {
    const selection = this.selectAt(when);
    if (selection.status !== "selected") return selection;
    const instant = selection.instant;
    const view = new RulePackageView({
      pkg: selection.entry.pkg,
      catalog: selection.entry.catalog,
      version: selection.version,
      digest: selection.digest,
    });
    const snapshot = view.rulesAt(instant, { roundId });
    if (snapshot.status === "none") {
      return deepFreeze({ status: "none", reason: snapshot.reason, activeRounds: snapshot.activeRounds });
    }
    if (snapshot.status === "blocked") {
      return deepFreeze({
        status: "blocked",
        reason: "STACK_BLOCKED",
        roundIds: snapshot.roundIds,
        stacking: snapshot.stacking,
        version: selection.version,
      });
    }
    return deepFreeze({
      status: "ok",
      version: selection.version,
      digest: selection.digest,
      instant,
      instantLocal: formatLocal(instant, view.timeZone),
      roundId: snapshot.roundId,
      activeRounds: snapshot.activeRounds,
      winningRound: snapshot.winningRound,
      mapRules: snapshot.mapRules,
      allowedAbilities: snapshot.allowedAbilities,
      scoringMultiplier: snapshot.scoringMultiplier,
      winnerCondition: snapshot.winnerCondition,
      stacking: snapshot.stacking,
    });
  }

  /** Roll back by re-publishing an earlier package. The published history is
   * append-only, so rollback is a new version whose content equals an earlier
   * one; existing matches keep their original pins, and new matches pick up the
   * rolled-back content from its new effective boundary.
   */
  rollback({ toVersion, at, expectCurrentDigest = undefined, publishedAt = null, id = null, displayName = null }) {
    const target = this.store.get(toVersion);
    if (!target) {
      return {
        status: "refused",
        stage: "rollback",
        reasonCodes: ["ROLLBACK_VERSION_UNKNOWN"],
        errors: [{ severity: "error", code: "ROLLBACK_VERSION_UNKNOWN", message: `no version ${toVersion}`, details: { toVersion } }],
        warnings: [],
      };
    }
    const resolvedAt = parseWhen(at);
    if (resolvedAt.status !== "ok") {
      return {
        status: "refused",
        stage: "rollback",
        reasonCodes: ["ROLLBACK_BOUNDARY_INVALID"],
        errors: [{ severity: "error", code: "ROLLBACK_BOUNDARY_INVALID", message: "rollback boundary is not resolvable", details: resolvedAt }],
        warnings: [],
      };
    }
    const resolvedPublishedAt = publishedAt === null ? null : parseWhen(publishedAt);
    if (resolvedPublishedAt && resolvedPublishedAt.status !== "ok") {
      return {
        status: "refused",
        stage: "rollback",
        reasonCodes: ["ROLLBACK_PUBLISHED_AT_INVALID"],
        errors: [{ severity: "error", code: "ROLLBACK_PUBLISHED_AT_INVALID", message: "rollback publishedAt is not resolvable", details: resolvedPublishedAt }],
        warnings: [],
      };
    }
    if (resolvedAt.instant < (resolvedPublishedAt?.instant ?? 0)) {
      return {
        status: "refused",
        stage: "rollback",
        reasonCodes: ["ROLLBACK_EFFECTIVE_BEFORE_PUBLICATION"],
        errors: [{ severity: "error", code: "ROLLBACK_EFFECTIVE_BEFORE_PUBLICATION", message: "rollback effective boundary precedes its publication", details: { at } }],
        warnings: [],
      };
    }
    const publication = resolvedPublishedAt
      ? new Date(resolvedPublishedAt.instant).toISOString()
      : new Date(this.timeSource.now()).toISOString();
    const source = target.materializedInputs;
    if (!source) {
      throw new PackageError("ROLLBACK_SOURCE_UNAVAILABLE", `v${toVersion} has no stored source inputs to replay`);
    }
    const rebuilt = {
      id: id ?? source.id,
      publishedAt: publication,
      timeZone: source.timeZone,
      schedule: source.schedule,
      defaults: source.defaults,
      mapPool: source.mapPool,
      scoring: source.scoring,
      abilities: source.abilities,
      composition: source.composition ?? {},
      effectiveFrom: at,
      displayName: displayName ?? `${target.displayName} (rollback of v${toVersion})`,
      notes: `rollback to v${toVersion}`,
      options: { rollbackOf: toVersion, sourceDigest: target.digest, sourceVersion: toVersion },
    };
    const result = this.publish(rebuilt, { expectCurrentDigest, allowTimestampChange: true });
    if (result.status === "published" || result.status === "duplicate") {
      this.history.push({
        kind: "rollback",
        at: this.timeSource.now(),
        toVersion,
        newVersion: result.version ?? null,
        digest: result.digest ?? null,
      });
    }
    return result;
  }

  /**
   * Resolve a match against the current store. Returns a diagnostic describing
   * whether its pin is still intact and which version it must keep using.
   */
  resolveMatch(matchId) {
    const match = this.requireMatch(matchId);
    const truth = verifyPin(match.pin);
    const live = this.store.get(match.pin.version);
    const current = this.store.head();
    const reasons = [];
    if (!truth.ok) reasons.push(truth);
    if (live && live.digest !== match.pin.digest) {
      reasons.push({
        code: "MATCH_PIN_SUPERSEDED",
        detail: { pinnedVersion: match.pin.version, pinnedDigest: match.pin.digest, liveDigest: live.digest },
      });
    }
    if (!live) {
      reasons.push({ code: "MATCH_PIN_ARCHIVED", detail: { pinnedVersion: match.pin.version } });
    }
    return {
      matchId,
      ok: reasons.length === 0,
      pinnedVersion: match.pin.version,
      pinnedDigest: match.pin.digest,
      currentVersion: current?.version ?? null,
      currentDigest: current?.digest ?? null,
      reasons,
      mustContinueWith: match.pin.version,
    };
  }

  /** Simulate "rollback the live store" without deleting history. */
  explainRollback(fromVersion, toVersion) {
    return explainSelection(this.store.get(fromVersion), this.store.get(toVersion));
  }

  stateAt(instant = this.timeSource.now()) {
    const selection = this.selectAt(instant);
    return deepFreeze({
      at: instant,
      atLocal: this.store.head() ? formatLocal(instant, this.store.head().pkg.timeZone) : null,
      currentVersion: this.store.head()?.version ?? null,
      selectedVersion: selection.status === "selected" ? selection.version : null,
      selectedDigest: selection.status === "selected" ? selection.digest : null,
      selectionReason: selection.status === "selected" ? null : selection.reason,
      matches: [...this.matches.values()].map((match) => ({
        matchId: match.matchId,
        version: match.pin.version,
        round: match.effectiveRound()?.resolution?.winners?.[0]?.id ?? null,
        scores: { ...match.scores },
      })),
    });
  }

  /** Data-only parallel-match timeline; the caller decides how to render it. */
  timeline(matchIds, window) {
    return buildTimeline(this, matchIds, window);
  }
}
