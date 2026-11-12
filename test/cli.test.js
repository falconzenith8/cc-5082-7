import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("cli/season-rules.js");
const INPUTS = resolve("scenarios/inputs");

function run(args, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    if (!allowFailure) throw error;
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("CLI assemble reports a sealed package for a valid input", () => {
  const result = run(["assemble", `${INPUTS}/v1.json`, "--catalog", `${INPUTS}/catalog.json`]);
  assert.match(result.stdout, /ASSEMBLED/);
  assert.match(result.stdout, /sha256:[0-9a-f]{64}/);
  assert.match(result.stdout, /Asia\/Shanghai/);
});

test("CLI assemble exits non-zero and names missing content for an invalid package", () => {
  const result = run(
    ["assemble", `${INPUTS}/invalid-resource.json`, "--catalog", `${INPUTS}/catalog.json`],
    { allowFailure: true },
  );
  assert.equal(result.code, 2);
  assert.match(result.stdout, /REFUSED/);
  assert.match(result.stdout, /glacier-rift/);
  assert.match(result.stdout, /grapple-hook/);
});

test("CLI publish accepts a good version chain and refuses a bad candidate in order", () => {
  const result = run(
    ["publish", `${INPUTS}/catalog.json`, `${INPUTS}/v1.json`, `${INPUTS}/v2.json`, `${INPUTS}/invalid-resource.json`],
    { allowFailure: true },
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /PUBLISHED .*v1\.json -> v1/);
  assert.match(result.stdout, /PUBLISHED .*v2\.json -> v2/);
  assert.match(result.stdout, /REFUSED .*invalid-resource\.json/);
  assert.match(result.stdout, /published versions: \[1,2\]/);
});

test("CLI inspect distinguishes a covered round from a gap with no fallback", () => {
  const covered = run([
    "inspect",
    `${INPUTS}/catalog.json`,
    `${INPUTS}/gap.json`,
    "--at",
    "2026-11-12T12:00:00",
  ]);
  assert.equal(covered.code, 0);
  assert.match(covered.stdout, /生效回合 sprint/);
  assert.match(covered.stdout, /得分倍率 1.5/);

  const hole = run(
    ["inspect", `${INPUTS}/catalog.json`, `${INPUTS}/gap.json`, "--at", "2026-11-14T12:00:00"],
    { allowFailure: true },
  );
  assert.equal(hole.code, 1);
  assert.match(hole.stdout, /NO_FALLBACK_POOL/);
});

test("CLI rejects usage errors with exit code 3", () => {
  const result = run(["inspect", `${INPUTS}/catalog.json`], { allowFailure: true });
  assert.equal(result.code, 3);
});
