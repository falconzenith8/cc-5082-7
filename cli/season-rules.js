import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";

import { SeasonEngine } from "../src/runtime/engine.js";
import { inspectAssembledPackage } from "../src/runtime/inspect.js";
import { VirtualClock } from "../src/time/clock.js";
import { normalizeCatalog } from "../src/catalog.js";
import { assemblePackage } from "../src/compose/assemble.js";

const USAGE = `season-rules — 赛季规则装配器 CLI

用法:
  node cli/season-rules.js assemble <package.json> [--catalog <catalog.json>] [--json]
      校验并装配单个规则包。不可用则以退出码 2 拒绝，并打印拒绝原因。
  node cli/season-rules.js publish <catalog.json> <package.json>... [--json]
      按发布时间顺序发布多个候选包，报告每版状态、摘要与拒绝原因。
  node cli/season-rules.js inspect <catalog.json> <package.json> --at <instant> [--json]
      查看某时刻生效的规则（不创建对局）。

选项:
  --catalog <file>  assemble 时使用的外部内容目录；缺省使用包内嵌 catalog。
  --at <instant>    inspect 时刻：ISO 8601，或 "YYYY-MM-DDTHH:mm:ss"（按包时区解释）。
  --json            机器可读输出。

退出码:
  0 成功   1 有候选被拒绝   2 单包装配被拒绝   3 用法错误   4 内部错误
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { command: null, positional: [], catalog: null, at: null, json: false };
  const rest = [...argv];
  args.command = rest.shift() ?? null;
  while (rest.length) {
    const token = rest.shift();
    if (token === "--json") args.json = true;
    else if (token === "--catalog") args.catalog = rest.shift();
    else if (token === "--at") args.at = rest.shift();
    else if (token.startsWith("--")) throw new UsageError(`未知选项 ${token}`);
    else args.positional.push(token);
  }
  return args;
}

function loadJson(file) {
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function loadCatalog(file) {
  const { catalog, digest } = normalizeCatalog(loadJson(file), { label: basename(file) });
  return { catalog, digest };
}

function printDiagnostics(result, indent = "  ") {
  if (result.errors?.length) {
    const codes = result.reasonCodes?.join(", ") ?? result.errors.map((error) => error.code).join(", ");
    console.log(`${indent}拒绝原因: ${codes}`);
    for (const error of result.errors) {
      console.log(`${indent}  - ${error.code}: ${error.message}`);
      for (const entry of error.details?.missing ?? []) {
        console.log(`${indent}      缺少 ${entry.kind} "${entry.contentId}"（${entry.path}）`);
      }
    }
  }
  if (result.warnings?.length) {
    console.log(`${indent}提示 ${result.warnings.length} 条:`);
    for (const warning of result.warnings) {
      console.log(`${indent}  - ${warning.code}: ${warning.message}`);
    }
  }
}

function toJsonable(value) {
  return JSON.parse(JSON.stringify(value));
}

function commandAssemble(args) {
  if (args.positional.length !== 1) throw new UsageError("assemble 需要一个规则包文件");
  const raw = loadJson(args.positional[0]);
  const source = args.catalog ? loadCatalog(args.catalog) : null;
  if (!source && !raw.catalog) throw new UsageError("包内未嵌 catalog；请提供 --catalog");
  const { catalog, digest } = source ?? normalizeCatalog(raw.catalog, { label: basename(args.positional[0]) });
  const result = assemblePackage(raw, { catalog, catalogDigest: digest, label: basename(args.positional[0]) });

  if (args.json) {
    console.log(JSON.stringify(toJsonable(result), null, 2));
  } else if (result.status === "refused") {
    console.log(`REFUSED ${args.positional[0]}`);
    printDiagnostics(result);
  } else {
    console.log(`ASSEMBLED ${args.positional[0]}`);
    console.log(`  package digest = ${result.package.identity.digest}`);
    console.log(`  catalog digest = ${result.catalogDigest}`);
    console.log(`  timeZone       = ${result.package.timeZone}`);
    console.log(`  rounds         = ${result.package.schedule.rounds.map((round) => round.id).join(", ")}`);
    console.log(`  input digests:`);
    for (const [key, value] of Object.entries(result.summaryInputs)) console.log(`    ${key.padEnd(12)} ${value}`);
    printDiagnostics(result);
  }
  return result.status === "refused" ? 2 : 0;
}

function commandPublish(args) {
  if (args.positional.length < 2) throw new UsageError("publish 需要 <catalog.json> 及至少一个规则包文件");
  const [catalogFile, ...packageFiles] = args.positional;
  const { catalog } = loadCatalog(catalogFile);
  const candidates = packageFiles
    .map((file) => ({ file, raw: loadJson(file) }))
    .sort((a, b) => String(a.raw.publishedAt ?? "").localeCompare(String(b.raw.publishedAt ?? "")));

  const earliest = candidates
    .map((entry) => Date.parse(entry.raw.publishedAt ?? ""))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const engine = new SeasonEngine({
    catalog,
    timeSource: new VirtualClock((earliest ?? Date.now()) - 60_000),
  });

  const outcomes = [];
  for (const candidate of candidates) {
    const publishedAt = Date.parse(candidate.raw.publishedAt ?? "");
    if (Number.isFinite(publishedAt) && publishedAt > engine.timeSource.now()) {
      engine.timeSource.set(publishedAt);
    }
    const result = engine.publish(candidate.raw);
    outcomes.push({
      file: candidate.file,
      id: candidate.raw.id ?? null,
      displayName: candidate.raw.displayName ?? null,
      status: result.status,
      version: result.status === "published" ? result.version : null,
      digest: result.status === "published" ? result.digest : result.status === "duplicate" ? result.digest : null,
      reasonCodes: result.status === "refused" ? result.reasonCodes : [],
      errors: result.status === "refused" ? result.errors : [],
      warnings: result.warnings ?? [],
      summaryInputs: result.status === "published" ? result.entry.diagnostics.summaryInputs : null,
    });
  }

  if (args.json) {
    console.log(JSON.stringify(toJsonable({ outcomes, history: engine.history }), null, 2));
  } else {
    for (const outcome of outcomes) {
      console.log(`${outcome.status.toUpperCase()} ${outcome.file}${outcome.version ? ` -> v${outcome.version}` : ""}`);
      if (outcome.digest) console.log(`  digest ${outcome.digest}`);
      if (outcome.reasonCodes.length) printDiagnostics({ errors: outcome.errors, reasonCodes: outcome.reasonCodes, warnings: outcome.warnings });
      else if (outcome.summaryInputs) {
        for (const [key, value] of Object.entries(outcome.summaryInputs)) console.log(`  ${key.padEnd(12)} ${value}`);
      }
    }
    console.log(`published versions: ${JSON.stringify(engine.store.versions())}`);
  }
  return outcomes.some((outcome) => outcome.status === "refused") ? 1 : 0;
}

function commandInspect(args) {
  if (args.positional.length !== 2) throw new UsageError("inspect 需要 <catalog.json> <package.json>");
  if (!args.at) throw new UsageError("inspect 需要 --at");
  const [catalogFile, packageFile] = args.positional;
  const { catalog, digest } = loadCatalog(catalogFile);
  const raw = loadJson(packageFile);
  const assembled = assemblePackage(raw, { catalog, catalogDigest: digest, label: basename(packageFile) });
  if (assembled.status === "refused") {
    if (args.json) console.log(JSON.stringify(toJsonable(assembled), null, 2));
    else printDiagnostics(assembled);
    return 2;
  }
  const inspection = inspectAssembledPackage(assembled, args.at);
  if (args.json) console.log(JSON.stringify(toJsonable(inspection), null, 2));
  else console.log(renderInspection(inspection));
  return inspection.status === "ok" ? 0 : 1;
}

function renderInspection(inspection) {
  if (inspection.status === "none") return `无可用规则：${inspection.reason}`;
  if (inspection.status === "blocked") {
    return `规则不可用：${inspection.reason}（${inspection.roundIds.join(", ")}）`;
  }
  return [
    `digest ${inspection.digest}`,
    `时刻 ${inspection.instantLocal}`,
    `生效回合 ${inspection.winningRound ?? "（无，使用包默认）"}`,
    `同时活动 ${inspection.activeRounds.join(", ") || "（无）"}`,
    `得分倍率 ${inspection.scoringMultiplier}`,
    `允许地图 ${inspection.mapRules.allowedMaps.join(", ") || "（无）"}`,
    `允许能力 ${inspection.allowedAbilities.join(", ") || "（无）"}`,
  ].join("\n");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 3;
  }
  if (!args.command || args.command === "help" || args.command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const handlers = { assemble: commandAssemble, publish: commandPublish, inspect: commandInspect };
  const handler = handlers[args.command];
  if (!handler) {
    console.error(`未知命令 ${args.command}`);
    console.error(USAGE);
    return 3;
  }
  try {
    const code = handler(args);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(USAGE);
      return 3;
    }
    console.error(error.stack ?? String(error));
    return 4;
  }
}

const exitCode = main();
process.exitCode = exitCode;
