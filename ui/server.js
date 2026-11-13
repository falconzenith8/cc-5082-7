import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { SeasonEngine } from "../src/runtime/engine.js";
import { VirtualClock } from "../src/time/clock.js";
import { formatLocal } from "../src/time/civil.js";
import { PackageError } from "../src/runtime/package.js";
import { shortDigest } from "../src/fingerprint.js";
import { catalog, v1, v2, invalidResourcePackage, gapPackage } from "../scenarios/scenario.js";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "public");
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const DEMO_PACKAGES = {
  v1,
  v2,
  "invalid-resource": invalidResourcePackage,
  gap: gapPackage,
};

/**
 * Match operations interface （对局操作界面）. A thin HTTP shell: every number
 * on screen is computed by the refactored domain modules — the server holds a
 * SeasonEngine with an explicitly injected time source, and the page renders
 * whatever the runtime returns. Domain exceptions (refusals, PackageError
 * codes) are serialized verbatim so the season-rules panel can surface them.
 */
export function createSeasonUi({
  engine = new SeasonEngine({ catalog, timeSource: new VirtualClock("2026-11-09T00:00:00Z") }),
  packages = DEMO_PACKAGES,
} = {}) {
  const timeZone = "Asia/Shanghai";

  const matchScreen = (match) => {
    const view = match.rulesView();
    return {
      matchId: match.matchId,
      status: match.status,
      createdAt: match.createdAt,
      createdAtLocal: match.createdAtLocal,
      ruleVersion: match.pin.version,
      ruleDigest: match.pin.digest,
      ruleDigestShort: shortDigest(match.pin.digest),
      ruleTitle: match.pin.title,
      roundId: view.roundId,
      activeRounds: view.activeRounds,
      scoringMultiplier: view.multiplier,
      allowedMaps: view.allowedMaps,
      defaultMap: view.defaultMap,
      allowedAbilities: view.allowedAbilities,
      winnerCondition: view.winnerCondition,
      scores: { ...match.scores },
      events: match.events.map((event) => ({ ...event })),
    };
  };

  const state = () => ({
    now: engine.timeSource.now(),
    nowLocal: formatLocal(engine.timeSource.now(), timeZone),
    timeZone,
    headVersion: engine.store.head()?.version ?? null,
    versions: engine.store.list().map((entry) => ({
      version: entry.version,
      digest: entry.digest,
      digestShort: shortDigest(entry.digest),
      packageId: entry.packageId,
      displayName: entry.displayName,
      effectiveFrom: entry.effectiveFrom,
      publishedAt: entry.publishedAt,
    })),
    matches: [...engine.matches.values()].map(matchScreen),
    refusals: engine.refusals.map((refusal) => ({
      stage: refusal.stage,
      reasonCodes: refusal.result.reasonCodes ?? [],
    })),
    history: engine.history.map((entry) => ({ ...entry, atLocal: formatLocal(entry.at, timeZone) })),
  });

  const routes = {
    "GET /api/state": () => ({ body: state() }),
    "GET /api/scenarios": () => ({ body: { packages: Object.keys(packages) } }),
    "POST /api/skip": ({ body }) => {
      const result = engine.skipTo(body.to, { timeZone });
      return { body: { before: result.before, after: result.after, elapsedMs: result.elapsedMs, state: state() } };
    },
    "POST /api/publish": ({ body }) => {
      const candidate = body.package ?? packages[body.scenario];
      if (!candidate) throw new PackageError("UI_PACKAGE_MISSING", "no package supplied");
      const result = engine.publish(candidate);
      return { status: result.status === "refused" ? 422 : 200, body: { result, state: state() } };
    },
    "POST /api/matches": ({ body }) => {
      const match = engine.startMatch({ matchId: body.matchId, at: body.at ?? engine.timeSource.now() });
      return { status: 201, body: { match: matchScreen(match), state: state() } };
    },
    "POST /api/inspect": ({ body }) => ({ body: { inspection: engine.inspectRulesAt(body.at) } }),
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname.startsWith("/api/scenarios/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/scenarios/".length));
        if (!packages[name]) return send(res, 404, { error: { code: "UI_SCENARIO_UNKNOWN", message: `unknown scenario ${name}` } });
        return send(res, 200, { package: packages[name] });
      }
      const matchResultRoute = /^\/api\/matches\/([^/]+)\/results$/.exec(url.pathname);
      if (req.method === "POST" && matchResultRoute) {
        const body = await readBody(req);
        const record = engine.reportResult(decodeURIComponent(matchResultRoute[1]), {
          kind: "map-result",
          side: body.side,
          mapId: body.mapId,
          abilityId: body.abilityId || undefined,
        });
        return send(res, 201, { record, state: state() });
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        const body = req.method === "POST" ? await readBody(req) : {};
        const { status = 200, body: payload } = handler({ body, query: url.searchParams });
        return send(res, status, payload);
      }
      if (req.method === "GET") {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        return await sendStatic(res, file);
      }
      send(res, 404, { error: { code: "UI_ROUTE_UNKNOWN", message: `${req.method} ${url.pathname}` } });
    } catch (error) {
      const domain = error instanceof PackageError || typeof error?.code === "string";
      send(res, domain ? 409 : 500, {
        error: {
          code: error.code ?? "UI_INTERNAL",
          message: error.message,
          details: error.details ?? null,
        },
      });
    }
  });
  return { server, engine, state };
}

async function sendStatic(res, file) {
  if (file.includes("..")) return send(res, 403, { error: { code: "UI_PATH", message: "forbidden" } });
  try {
    const content = await readFile(resolve(PUBLIC_DIR, file));
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    send(res, 404, { error: { code: "UI_NOT_FOUND", message: file } });
  }
}

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new PackageError("UI_BODY_TOO_LARGE", "request body exceeds 1MB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const { server } = createSeasonUi();
  server.listen(port, () => {
    console.log(`赛季规则对局界面: http://localhost:${port}`);
  });
}
