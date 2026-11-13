import test from "node:test";
import assert from "node:assert/strict";

import { createSeasonUi } from "../ui/server.js";
import { SeasonEngine } from "../src/runtime/engine.js";
import { VirtualClock } from "../src/time/clock.js";
import { catalog, v1, v2, invalidResourcePackage } from "../scenarios/scenario.js";

/**
 * The match operations interface is an HTTP shell over the refactored modules.
 * These tests drive it the way the page does: publish, fast-forward, create
 * two matches across the rotation boundary, and read the match screens.
 */

async function withUi(run) {
  const engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") });
  const { server } = createSeasonUi({ engine });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = async (base, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test("the UI serves the match operations page and its assets", async () => {
  await withUi(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /对局操作界面/);
    const app = await fetch(`${base}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type"), /javascript/);
  });
});

test("fast-forward plus two matches across the boundary shows both screens with rule versions", async () => {
  await withUi(async (base) => {
    assert.equal((await post(base, "/api/publish", { scenario: "v1" })).body.result.status, "published");
    await post(base, "/api/skip", { to: "2026-11-12T20:00:00+08:00" });

    const alpha = await post(base, "/api/matches", { matchId: "alpha" });
    assert.equal(alpha.status, 201);
    assert.equal(alpha.body.match.ruleVersion, 1);
    const alphaScore = await post(base, "/api/matches/alpha/results", { side: "a", mapId: "neon-docks" });
    assert.equal(alphaScore.body.record.points, 15);

    await post(base, "/api/skip", { to: "2026-11-13T00:00:00+08:00" });
    assert.equal((await post(base, "/api/publish", { scenario: "v2" })).body.result.status, "published");
    await post(base, "/api/skip", { to: "2026-11-13T09:00:00+08:00" });

    const beta = await post(base, "/api/matches", { matchId: "beta" });
    assert.equal(beta.body.match.ruleVersion, 2);
    const betaScore = await post(base, "/api/matches/beta/results", { side: "a", mapId: "highland-pass" });
    assert.equal(betaScore.body.record.points, 8);

    const state = (await fetch(`${base}/api/state`).then((res) => res.json()));
    assert.equal(state.matches.length, 2);
    const screenA = state.matches.find((match) => match.matchId === "alpha");
    const screenB = state.matches.find((match) => match.matchId === "beta");
    assert.equal(screenA.ruleVersion, 1);
    assert.equal(screenB.ruleVersion, 2);
    assert.equal(screenA.scoringMultiplier, 1.5);
    assert.equal(screenB.scoringMultiplier, 0.8);
    assert.deepEqual(screenA.scores, { a: 15, b: 0 });
    assert.deepEqual(screenB.scores, { a: 8, b: 0 });
    assert.ok(screenA.allowedAbilities.includes("blink"));
    assert.ok(!screenB.allowedAbilities.includes("blink"), "beta's pinned rules deny blink");
    assert.ok(!screenB.allowedAbilities.includes("drone"), "v2 denies drone");
  });
});

test("domain exceptions surface through the API for the season-rules panel", async () => {
  await withUi(async (base) => {
    assert.equal((await post(base, "/api/publish", { scenario: "v1" })).body.result.status, "published");

    const refused = await post(base, "/api/publish", { package: invalidResourcePackage });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body.result.reasonCodes, ["RESOURCE_REFERENCE_MISSING"]);
    assert.ok(refused.body.state.refusals.length >= 1);

    await post(base, "/api/skip", { to: "2026-11-12T20:00:00+08:00" });
    await post(base, "/api/matches", { matchId: "alpha" });
    const denied = await post(base, "/api/matches/alpha/results", {
      side: "a",
      mapId: "frost-cavern",
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, "MATCH_MAP_NOT_ALLOWED");

    const backwards = await post(base, "/api/skip", { to: "2026-11-10T00:00:00+08:00" });
    assert.equal(backwards.status, 409);
    assert.equal(backwards.body.error.code, "CLOCK_BACKWARDS");
  });
});
