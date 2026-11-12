import { activeRoundsAt, stackResolution, scoringMultiplier } from "../src/rules.js";
import { formatLocal } from "../src/time.js";
import { shortDigest } from "../src/fingerprint.js";

/**
 * Timeline views for parallel matches. These are data structures, not renderers:
 * the same shape is consumed by tests and by the CLI demo, and every field is
 * derived from the exact package the match is pinned to.
 *
 * Samples report the match's *frozen* binding, not what the package would hand
 * to a newly created match at that instant. That distinction is the whole point:
 * a rotation boundary changes what new matches get, never what a live match uses.
 */
export function buildTimeline(engine, matchIds, { from, to }) {
  const fromInstant = typeof from === "number" ? from : Date.parse(from);
  const toInstant = typeof to === "number" ? to : Date.parse(to);
  const boundaryVersions = new Map();
  for (const entry of engine.store.listEntries()) {
    const effective = Date.parse(entry.effectiveFrom);
    if (effective >= fromInstant && effective <= toInstant) {
      boundaryVersions.set(effective, entry);
    }
  }

  const rows = [];
  for (const matchId of matchIds) {
    const match = engine.getMatch(matchId);
    if (!match) continue;
    const core = match.pin.core;
    const frozen = match.effectiveRound();
    const frozenWinner = frozen.resolution.winners[0] ?? null;
    const frozenMultiplier = scoringMultiplier(
      core,
      frozen.resolution.compatible ? frozen.resolution.winners : [],
    ).multiplier;

    const refs = [];
    for (const round of core.schedule.rounds) {
      if (round.startsAtInstant === null) continue;
      const start = Date.parse(round.startsAtInstant);
      const end = round.endsAtInstant === null ? Infinity : Date.parse(round.endsAtInstant);
      if (start <= toInstant && end >= fromInstant) refs.push({ round, start, end });
    }

    const points = new Set([fromInstant, toInstant, match.createdAt]);
    for (const ref of refs) {
      if (ref.start >= fromInstant && ref.start <= toInstant) points.add(ref.start);
      if (ref.end >= fromInstant && ref.end <= toInstant) points.add(ref.end);
    }
    for (const instant of boundaryVersions.keys()) points.add(instant);

    const samples = [];
    for (const instant of [...points].sort((a, b) => a - b)) {
      samples.push({
        at: instant,
        atLocal: formatLocal(instant, match.pin.timeZone),
        frozenRound: frozenWinner?.id ?? null,
        frozenRounds: frozen.rounds.map((round) => round.id),
        frozenMultiplier,
        blocked: frozen.resolution.compatible ? null : frozen.resolution.reason,
        packageWouldSelect: selectAtInstant(core, instant),
        pinnedVersion: match.pin.version,
      });
    }

    rows.push({
      matchId,
      pinnedVersion: match.pin.version,
      pinnedDigest: match.pin.digest,
      pinnedDigestShort: shortDigest(match.pin.digest),
      createdAt: match.createdAt,
      createdAtLocal: match.createdAtLocal,
      frozenRound: frozenWinner?.id ?? null,
      frozenMultiplier,
      frozenRounds: frozen.rounds.map((round) => round.id),
      scores: { ...match.scores },
      samples,
    });
  }

  const boundaries = [...boundaryVersions.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([instant, entry]) => ({
      at: instant,
      atLocal: formatLocal(instant, entry.pkg.timeZone),
      version: entry.version,
      digestShort: shortDigest(entry.digest),
      displayName: entry.displayName,
    }));

  return {
    from: fromInstant,
    to: toInstant,
    fromLocal: rows[0] ? formatLocal(fromInstant, engine.getMatch(rows[0].matchId).pin.timeZone) : null,
    toLocal: rows[0] ? formatLocal(toInstant, engine.getMatch(rows[0].matchId).pin.timeZone) : null,
    boundaries,
    matches: rows,
    changingRules: rows.length === 2 && rows[0].pinnedDigest !== rows[1].pinnedDigest,
  };
}

function selectAtInstant(core, instant) {
  const active = activeRoundsAt(core, instant);
  const resolution = stackResolution(core, active);
  const winner = resolution.winners[0] ?? null;
  return {
    rounds: active.map((round) => round.id),
    winner: winner?.id ?? null,
    multiplier: scoringMultiplier(core, resolution.compatible ? resolution.winners : []).multiplier,
  };
}

export function describeTimeline(timeline) {
  const lines = [];
  lines.push(`窗口 ${timeline.fromLocal} .. ${timeline.toLocal}`);
  if (timeline.boundaries.length) {
    lines.push("版本生效边界:");
    for (const boundary of timeline.boundaries) {
      lines.push(`  v${boundary.version} ${boundary.digestShort} effective ${boundary.atLocal} (${boundary.displayName})`);
    }
  }
  for (const match of timeline.matches) {
    lines.push(
      `${match.matchId}: pinned v${match.pinnedVersion} ${match.pinnedDigestShort} created ${match.createdAtLocal} round=${match.frozenRound ?? "-"} x${match.frozenMultiplier} scores ${JSON.stringify(match.scores)}`,
    );
    for (const sample of match.samples) {
      const selection = sample.packageWouldSelect;
      lines.push(
        `  ${sample.atLocal}  frozen=${sample.frozenRound ?? "-"} x${sample.frozenMultiplier}  package-now=${selection.winner ?? "-"} x${selection.multiplier}`,
      );
    }
  }
  return lines.join("\n");
}


