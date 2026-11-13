import { SeasonEngine } from "../src/runtime/engine.js";
import { inspectAssembledPackage } from "../src/runtime/inspect.js";
import { VirtualClock } from "../src/time/clock.js";
import { resolveLocal, formatLocal } from "../src/time/civil.js";
import { describeSelection, compareEntries } from "../src/runtime/report.js";
import { assemblePackage } from "../src/compose/assemble.js";
import { normalizeCatalog } from "../src/catalog.js";
import { canonicalize } from "../src/fingerprint.js";
import {
  catalog,
  v1,
  v2,
  invalidResourcePackage,
  unresolvedOverlapPackage,
  resolvedOverlapPackage,
  excludedOverlapPackage,
  gapPackage,
} from "../scenarios/scenario.js";

/**
 * Deterministic runtime trace. The golden copy of this output (captured from
 * the pre-refactor runtime) lives at scenarios/expected/runtime-trace.json;
 * scripts/compare-runtime.js regenerates this trace and diffs the two.
 */

const TZ = "Asia/Shanghai";
const trace = {};

// 1. Standalone assembly (offline composition path).
const standalone = assemblePackage(v1, {
  catalog,
  catalogDigest: normalizeCatalog(catalog).digest,
  label: "trace",
});
trace.standaloneAssemble = {
  status: standalone.status,
  digest: standalone.package.identity.digest,
  summaryInputs: standalone.summaryInputs,
  warnings: standalone.warnings,
};

// 2. Engine publication and boundary selection.
const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
engine.skipTo("2026-11-10T00:00:00Z", { matchIds: [] });
const p1 = engine.publish(v1);
trace.publishV1 = {
  status: p1.status,
  version: p1.version,
  digest: p1.digest,
  effectiveFrom: p1.entry.effectiveFrom,
  warnings: p1.warnings,
  summary: p1.summary,
};
trace.selectBoundary = {
  before: engine.selectAt("2026-11-11T23:59:59+08:00"),
  at: engine.selectAt("2026-11-12T00:00:00+08:00"),
  utcEdge: engine.selectAt("2026-11-11T16:00:00Z"),
};

// 3. Refusals: missing resources, unresolved overlap, gap warnings.
const bad = engine.publish(invalidResourcePackage);
trace.refusals = {
  invalidResource: { status: bad.status, reasonCodes: bad.reasonCodes, errors: bad.errors },
  unresolvedOverlap: (() => {
    const e = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
    const r = e.publish(unresolvedOverlapPackage, { now: Date.parse("2026-11-10T00:00:00Z") });
    return { status: r.status, reasonCodes: r.reasonCodes, errors: r.errors };
  })(),
  priorityOverlap: (() => {
    const e = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
    const r = e.publish(resolvedOverlapPackage, { now: Date.parse("2026-11-10T00:00:00Z") });
    return { status: r.status, version: r.version ?? null, warnings: r.warnings ?? [] };
  })(),
  excludedOverlap: (() => {
    const e = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
    const r = e.publish(excludedOverlapPackage, { now: Date.parse("2026-11-10T00:00:00Z") });
    return { status: r.status, version: r.version ?? null, warnings: r.warnings ?? [] };
  })(),
  gapPackage: (() => {
    const e = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
    const r = e.publish(gapPackage, { now: Date.parse("2026-11-10T00:00:00Z") });
    return { status: r.status, warnings: r.warnings ?? [] };
  })(),
};

// 4. Two matches across the rotation boundary.
engine.skipTo("2026-11-12T20:00:00+08:00", { matchIds: [] });
engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
const alphaEvents = [
  engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks" }),
  engine.reportResult("alpha", { kind: "map-result", side: "b", mapId: "highland-pass" }),
];
engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["alpha"] });
const p2 = engine.publish(v2);
engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: ["alpha"] });
engine.startMatch({ matchId: "beta", at: "2026-11-13T09:00:00+08:00" });
const betaEvents = [
  engine.reportResult("beta", { kind: "map-result", side: "a", mapId: "highland-pass" }),
  engine.reportResult("beta", { kind: "map-result", side: "b", mapId: "highland-pass" }),
];
trace.publishV2 = { status: p2.status, version: p2.version, digest: p2.digest };
trace.matches = {
  alpha: {
    pin: { version: engine.getMatch("alpha").pin.version, digest: engine.getMatch("alpha").pin.digest },
    scores: engine.getMatch("alpha").scores,
    events: alphaEvents,
    rulesView: engine.getMatch("alpha").rulesView(),
  },
  beta: {
    pin: { version: engine.getMatch("beta").pin.version, digest: engine.getMatch("beta").pin.digest },
    scores: engine.getMatch("beta").scores,
    events: betaEvents,
    rulesView: engine.getMatch("beta").rulesView(),
  },
};
trace.comparison = engine.compareObservations("alpha", "beta", engine.timeSource.now());
trace.inspect = {
  sprint: engine.inspectRulesAt("2026-11-12T20:00:00+08:00"),
  climber: engine.inspectRulesAt("2026-11-13T09:00:00+08:00"),
};

// 5. Timeline across the boundary.
trace.timeline = engine.timeline(["alpha", "beta"], {
  from: "2026-11-12T18:00:00+08:00",
  to: "2026-11-14T12:00:00+08:00",
});

// 6. Rollback (append-only) and resolution diagnostics.
engine.skipTo("2026-11-13T20:00:00+08:00", { matchIds: ["alpha", "beta"] });
const rollback = engine.rollback({
  toVersion: 1,
  at: "2026-11-14T00:00:00+08:00",
  publishedAt: "2026-11-13T20:00:00+08:00",
});
trace.rollback = {
  status: rollback.status,
  version: rollback.version ?? null,
  digest: rollback.digest ?? null,
  resolveAlpha: engine.resolveMatch("alpha"),
  resolveBeta: engine.resolveMatch("beta"),
};

// 7. Degraded catalog refusal.
const degraded = { ...catalog, maps: { ...catalog.maps } };
delete degraded.maps["frost-cavern"];
const degradedResult = engine.publish(
  {
    ...v2,
    id: "season-26-autumn-v3",
    publishedAt: "2026-11-14T00:00:00+08:00",
    effectiveFrom: "2026-11-15T00:00:00+08:00",
  },
  { catalog: degraded, catalogDigest: "sha256:" + "0".repeat(64) },
);
trace.degradedCatalog = { status: degradedResult.status, reasonCodes: degradedResult.reasonCodes, errors: degradedResult.errors };

// 8. Summaries, state, history.
trace.summaries = {
  v1: describeSelection(engine.store, engine.store.get(1)),
  v2: describeSelection(engine.store, engine.store.get(2)),
  compare: compareEntries(engine.store, 1, 2),
};
trace.stateAt = engine.stateAt(engine.timeSource.now());
trace.history = engine.history;
trace.engineRefusals = engine.refusals;

// 9. Offline inspection (CLI path) and time-zone edge cases.
const assembledV1 = assemblePackage(v1, { catalog, catalogDigest: normalizeCatalog(catalog).digest });
trace.offlineInspect = {
  covered: inspectAssembledPackage(assembledV1, "2026-11-12T20:00:00"),
  hole: inspectAssembledPackage(
    assemblePackage(gapPackage, { catalog, catalogDigest: normalizeCatalog(catalog).digest }),
    "2026-11-14T12:00:00",
  ),
};
trace.timeLayer = {
  nonexistent: resolveLocal("America/New_York", "2026-03-08T02:30:00"),
  ambiguous: resolveLocal("America/New_York", "2026-11-01T01:30:00"),
  crossDay: formatLocal(Date.parse("2026-11-12T23:59:59+08:00") + 1000, TZ),
};

process.stdout.write(JSON.stringify(canonicalize(trace), null, 2) + "\n");
