import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Old-vs-new runtime comparison. The golden trace at
 * scenarios/expected/runtime-trace.json was captured from the pre-refactor
 * runtime; this script regenerates the trace with the current modules and
 * diffs them field by field. Any difference means the refactor changed the
 * business meaning of season switching and must be treated as a bug.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = resolve(root, "scenarios/expected/runtime-trace.json");

const actual = execFileSync(process.execPath, [resolve(root, "scripts/runtime-trace.js")], {
  encoding: "utf8",
});
const expected = readFileSync(goldenPath, "utf8");

if (actual === expected) {
  console.log(`runtime comparison: IDENTICAL (${actual.length} bytes, golden ${goldenPath})`);
  process.exit(0);
}

const diffs = [];
collectDiffs(JSON.parse(expected), JSON.parse(actual), "", diffs);
console.error(`runtime comparison: ${diffs.length} difference(s) against ${goldenPath}`);
for (const diff of diffs.slice(0, 50)) {
  console.error(`  ${diff.path}: expected ${JSON.stringify(diff.expected)} got ${JSON.stringify(diff.actual)}`);
}
process.exit(1);

function collectDiffs(a, b, path, out) {
  if (Object.is(a, b)) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    out.push({ path: path || "/", expected: a, actual: b });
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: path || "/", expected: a, actual: b });
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: `${path}/length`, expected: a.length, actual: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) collectDiffs(a[i], b[i], `${path}/${i}`, out);
    return;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    collectDiffs(a[key], b[key], `${path}/${key}`, out);
  }
}
