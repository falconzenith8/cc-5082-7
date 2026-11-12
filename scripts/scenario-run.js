import { SeasonEngine } from "../src/engine.js";
import { VirtualClock, formatLocal } from "../src/time.js";
import { describeSelection, compareEntries } from "../src/report.js";
import { describeTimeline } from "../src/timeline.js";
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

const line = (char = "=", width = 78) => char.repeat(width);
const tz = "Asia/Shanghai";

const engine = new SeasonEngine({ catalog, clock: new VirtualClock("2026-11-09T00:00:00Z") });

function show(instant) {
  return formatLocal(instant, tz);
}

function publishBlock(title) {
  console.log();
  console.log(line());
  console.log(title);
  console.log(line());
}

function freshEngine(start = "2026-11-09T00:00:00Z") {
  return new SeasonEngine({ catalog, clock: new VirtualClock(start) });
}

publishBlock("1. 装配与发布：v1（跨日启用 00:00+08:00）");
engine.skipTo("2026-11-10T00:00:00Z");
const p1 = engine.publish(v1);
if (p1.status !== "published") {
  console.error("v1 refused:", JSON.stringify(p1.errors, null, 2));
  process.exit(1);
}
console.log(`status=${p1.status} version=v${p1.version} digest=${p1.digest}`);
console.log(`effectiveFrom=${p1.entry.effectiveFromLocal}  publishedAt=${p1.summary.publishedAt}`);
console.log(`displayName="${p1.summary.displayName}"`);
console.log(`rounds (local):`);
for (const round of p1.summary.content.rounds) {
  console.log(
    `  ${round.id}: ${formatLocal(Date.parse(round.startsAtInstant), tz)} .. ${formatLocal(Date.parse(round.endsAtInstant), tz)}`,
  );
}
for (const warning of p1.warnings) console.log(`  warning ${warning.code}: ${warning.message}`);

publishBlock("2. 拒绝生成：引用不存在的资源");
const bad = freshEngine().publish(invalidResourcePackage);
console.log(`status=${bad.status} reasonCodes=${bad.reasonCodes?.join(",")}`);
for (const error of bad.errors ?? []) {
  console.log(`  ${error.code}: ${error.message}`);
  for (const missing of error.details?.missing ?? []) {
    console.log(`    missing ${missing.kind} "${missing.contentId}" at ${missing.path}`);
  }
}

publishBlock("3. 拒绝生成：无法解析的活动叠加");
const overlapEngine = freshEngine();
const unresolved = overlapEngine.publish(unresolvedOverlapPackage);
console.log(`未声明优先级的并列重叠 -> ${unresolved.status} ${unresolved.reasonCodes?.join(",") ?? ""}`);
for (const error of unresolved.errors ?? []) {
  if (error.details?.rounds) console.log(`    rounds=${error.details.rounds.join(",")} reason=${error.details.reason}`);
}
const resolved = overlapEngine.publish(resolvedOverlapPackage);
console.log(`显式 priority -> ${resolved.status}${resolved.status === "published" ? ` v${resolved.version}` : ` ${resolved.reasonCodes?.join(",")}`}`);
const excluded = overlapEngine.publish(excludedOverlapPackage);
console.log(`互斥 exclusions -> ${excluded.status}${excluded.status === "published" ? ` v${excluded.version}` : ` ${excluded.reasonCodes?.join(",")}`}`);

publishBlock("4. 时表空窗：显式提示与兜底池");
const gap = freshEngine().publish(gapPackage);
console.log(`status=${gap.status}${gap.status === "published" ? ` v${gap.version}` : ` ${gap.reasonCodes?.join(",")}`}`);
for (const warning of gap.warnings ?? []) {
  console.log(`  ${warning.code}: ${warning.message}`);
  if (warning.details?.gapStartLocal) {
    console.log(`    ${warning.details.gapStartLocal} .. ${warning.details.gapEndLocal} (${tz})`);
  }
}

publishBlock("5. 时间快进与并行对局跨轮换边界");
const m1At = "2026-11-12T20:00:00+08:00";
const skip = engine.skipTo(m1At, { matchIds: [] });
console.log(`时间快进 ${formatLocal(skip.after, tz)}（elapsed ${skip.elapsedMs / 3_600_000}h）`);
engine.startMatch({ matchId: "alpha", at: m1At });
engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks" });
engine.reportResult("alpha", { kind: "map-result", side: "b", mapId: "highland-pass" });
const alpha = engine.getMatch("alpha");
console.log(`alpha 创建于 ${show(alpha.createdAt)} -> v${alpha.pin.version} digest ${alpha.pin.digest.slice(0, 15)}…`);
console.log(`  scores=${JSON.stringify(alpha.scores)} events=${alpha.events.map((event) => `${event.mapId}+${event.points}`).join(",")}`);

engine.skipTo("2026-11-13T00:00:00+08:00", { matchIds: ["alpha"] });
console.log(`时间快进到轮换边界 ${show(engine.clock.now())}`);

const p2 = engine.publish(v2);
if (p2.status !== "published") {
  console.error("v2 refused:", JSON.stringify(p2.errors, null, 2));
  process.exit(1);
}
console.log(`v2 发布 at ${show(engine.clock.now())} -> v${p2.version} digest ${p2.digest.slice(0, 15)}…`);
console.log(`  v2 effectiveFrom=${p2.entry.effectiveFromLocal}`);

engine.skipTo("2026-11-13T09:00:00+08:00", { matchIds: ["alpha"] });
engine.startMatch({ matchId: "beta", at: "2026-11-13T09:00:00+08:00" });
engine.reportResult("beta", { kind: "map-result", side: "a", mapId: "highland-pass" });
engine.reportResult("beta", { kind: "map-result", side: "b", mapId: "highland-pass" });
const beta = engine.getMatch("beta");
console.log(`beta 创建于 ${show(beta.createdAt)} -> v${beta.pin.version} digest ${beta.pin.digest.slice(0, 15)}…`);
console.log(`  scores=${JSON.stringify(beta.scores)} events=${beta.events.map((event) => `${event.mapId}+${event.points}`).join(",")}`);

const comparison = engine.compareObservations("alpha", "beta", engine.clock.now());
console.log();
console.log(`观察时刻 ${show(comparison.at)}：alpha(v${comparison.a.packageVersion}) vs beta(v${comparison.b.packageVersion})`);
for (const difference of comparison.differences) {
  console.log(`  ${difference.field}:`);
  console.log(`    alpha = ${JSON.stringify(difference.a)}`);
  console.log(`    beta  = ${JSON.stringify(difference.b)}`);
}

const versionAlpha = engine.store.availableAt(Date.parse("2026-11-12T20:00:00+08:00"))[0].version;
const versionBeta = engine.store.availableAt(Date.parse("2026-11-13T09:00:00+08:00"))[0].version;
const uniqueVersions = [...new Set([versionAlpha, versionBeta])].sort((a, b) => a - b);
if (uniqueVersions.length < 2) throw new Error("expected two distinct package versions in play");

publishBlock("6. 规则摘要关联具体输入配置，而非版本名");
const summaryB = describeSelection(engine.store, engine.store.get(versionBeta));
const diff = compareEntries(engine.store, versionAlpha, versionBeta);
console.log(`v${versionBeta} displayName="${summaryB.displayName}"`);
console.log(`v${versionBeta} package digest   = ${summaryB.digest}`);
console.log(`v${versionBeta} input digests    = ${JSON.stringify(summaryB.inputDigests)}`);
console.log(`v${versionAlpha} 对比：sameDisplayName=${diff.sameDisplayName} sameDigest=${diff.sameDigest} sameInputs=${diff.sameInputs}`);
console.log(`changed input sections: ${diff.changedInputs.join(", ")}`);
for (const change of diff.inputDiff) {
  console.log(`  ${change.input}: ${String(change.from).slice(0, 15)}… -> ${String(change.to).slice(0, 15)}…`);
}

publishBlock("7. 回退旧包");
engine.skipTo("2026-11-13T20:00:00+08:00", { matchIds: ["alpha", "beta"] });
const rollback = engine.rollback({
  toVersion: versionAlpha,
  at: "2026-11-14T00:00:00+08:00",
  publishedAt: "2026-11-13T20:00:00+08:00",
});
console.log(`rollback v${versionAlpha} -> ${rollback.status}${rollback.status === "published" ? ` v${rollback.version}` : ` ${rollback.reasonCodes?.join(",")}`}`);
if (rollback.status === "published") {
  const newEntry = engine.store.get(rollback.version);
  const oldEntry = engine.store.get(versionAlpha);
  console.log(`  新包 digest 与 v${versionAlpha} 不同（身份含发布时间）：${newEntry.digest !== oldEntry.digest}`);
  console.log(`  但 schedule/scoring 输入摘要等于 v${versionAlpha}：${newEntry.diagnostics.summaryInputs.schedule === oldEntry.diagnostics.summaryInputs.schedule && newEntry.diagnostics.summaryInputs.scoring === oldEntry.diagnostics.summaryInputs.scoring}`);
  console.log(`  head=v${engine.store.head().version}`);
  console.log(`  进行中对局仍绑定原包：${[...engine.matches.values()].map((match) => `${match.matchId}->v${match.pin.version}`).join(" ")}`);
  const betaCheck = engine.resolveMatch("beta");
  console.log(`  beta 解析：pinned=v${betaCheck.pinnedVersion} current=v${betaCheck.currentVersion} ok=${betaCheck.ok}`);
}

publishBlock("8. 资源引用失效：已存档包遇到降级目录");
const degraded = { ...catalog, maps: { ...catalog.maps } };
delete degraded.maps["frost-cavern"];
const degradedResult = engine.publish(
  {
    ...v2,
    id: "season-26-autumn-v3",
    publishedAt: "2026-11-14T00:00:00+08:00",
    effectiveFrom: "2026-11-15T00:00:00+08:00",
    displayName: "Autumn Season — v3",
  },
  { catalog: degraded, catalogDigest: "sha256:" + "0".repeat(64) },
);
console.log(`status=${degradedResult.status} reasonCodes=${degradedResult.reasonCodes?.join(",")}`);
for (const error of degradedResult.errors ?? []) {
  const missing = error.details?.missing ?? [];
  if (missing.length) {
    for (const entry of missing) console.log(`  missing ${entry.kind} "${entry.contentId}" at ${entry.path}`);
  } else {
    console.log(`  ${error.code}: ${error.message}`);
  }
}
if (degradedResult.stage === "snapshot") {
  for (const error of degradedResult.errors) {
    if (error.code === "SNAPSHOT_RESOURCE_REFERENCE_MISSING") {
      for (const entry of error.details.missing) console.log(`  v${error.details.version} ${error.details.roundId}: missing ${entry.kind} "${entry.contentId}"`);
    }
  }
}

publishBlock("9. 比赛内得分与限制确实随包变化");
for (const matchId of ["alpha", "beta"]) {
  const match = engine.getMatch(matchId);
  const view = match.rulesView();
  console.log(`${matchId} pinned v${match.pin.version}`);
  console.log(`  multiplier=${view.multiplier} source=${view.stacking?.winners?.map((round) => round.id).join(",") || "base"}`);
  console.log(`  allowedMaps=${view.allowedMaps.join(",")}`);
  console.log(`  allowedAbilities=${view.allowedAbilities.join(",")}`);
  for (const event of match.events) {
    console.log(
      `  event#${event.seq} map=${event.mapId} base=${event.basePoints} x${event.multiplier} bonus=${event.perMapBonus} => ${event.points} (rules v${event.packageVersion})`,
    );
  }
}
const sprintRules = engine.inspectRulesAt("2026-11-12T20:00:00+08:00");
const climberRules = engine.inspectRulesAt("2026-11-13T09:00:00+08:00");
console.log(`sprint(v${sprintRules.version}) multiplier=${sprintRules.scoringMultiplier} blink=${sprintRules.allowedAbilities.includes("blink")}`);
console.log(`climber(v${climberRules.version}) multiplier=${climberRules.scoringMultiplier} blink=${climberRules.allowedAbilities.includes("blink")} drone=${climberRules.allowedAbilities.includes("drone")}`);
console.log(`同一地图 highland-pass 在 alpha/climber 包下基础分：base=${beta.events[0].basePoints} x${beta.events[0].multiplier} = ${beta.events[0].points}`);
console.log(`同一地图 highland-pass 在 v1 的 sprint（10 x 1.5）若通过 alpha 结算：${alpha.events[1].basePoints} x${alpha.events[1].multiplier} = ${alpha.events[1].points}`);

console.log();
console.log(line());
console.log("10. 并行比赛时间线视图（冻结绑定 vs 包当前选择）");
console.log(line());
console.log(
  describeTimeline(
    engine.timeline(["alpha", "beta"], {
      from: "2026-11-12T18:00:00+08:00",
      to: "2026-11-14T12:00:00+08:00",
    }),
  ),
);

publishBlock("11. 拒绝记录与引擎历史");
for (const entry of engine.history) {
  const details = { ...entry };
  delete details.kind;
  delete details.at;
  console.log(`  ${entry.kind.padEnd(8)} @ ${show(entry.at)} ${JSON.stringify(details)}`);
}
console.log(`refusals: ${engine.refusals.length}`);
for (const refusal of engine.refusals) {
  console.log(`  ${refusal.stage}: ${refusal.result.reasonCodes?.join(",")}`);
}
