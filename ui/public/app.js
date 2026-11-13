const $ = (selector) => document.querySelector(selector);

/** All domain errors surface in the season-rules panel diagnostics area. */
function showDiagnostics(payload) {
  const box = $("#diagnostics");
  if (!payload) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  if (payload.error) {
    box.textContent = `异常 ${payload.error.code}: ${payload.error.message}`;
    return;
  }
  if (payload.result && payload.result.status === "refused") {
    const lines = [`拒绝（${payload.result.stage ?? "?"}）: ${(payload.result.reasonCodes ?? []).join(", ")}`];
    for (const error of payload.result.errors ?? []) {
      lines.push(`  ${error.code}: ${error.message}`);
      for (const missing of error.details?.missing ?? []) {
        lines.push(`    缺少 ${missing.kind} "${missing.contentId}"（${missing.path}）`);
      }
    }
    box.textContent = lines.join("\n");
    return;
  }
  box.textContent = "";
  box.hidden = true;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    showDiagnostics(payload);
    throw Object.assign(new Error(payload.error?.message ?? response.statusText), { payload });
  }
  return payload;
}

function renderState(state) {
  $("#now").textContent = `${state.nowLocal}（v${state.headVersion ?? "-"} 为最新）`;
  const tbody = $("#versions tbody");
  tbody.textContent = "";
  for (const version of state.versions) {
    const row = document.createElement("tr");
    for (const text of [`v${version.version}`, version.digestShort, version.displayName, version.effectiveFrom]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    tbody.append(row);
  }
  const matches = $("#matches");
  matches.textContent = "";
  for (const match of state.matches) {
    matches.append(renderMatch(match));
  }
}

function renderMatch(match) {
  const card = document.createElement("article");
  card.className = "match-card";

  const title = document.createElement("h3");
  title.textContent = `${match.matchId} · 规则版本 v${match.ruleVersion} (${match.ruleDigestShort})`;
  card.append(title);

  const facts = document.createElement("dl");
  const entries = [
    ["创建时刻", match.createdAtLocal],
    ["状态", match.status],
    ["回合", match.roundId ?? "（包默认）"],
    ["得分倍率", `x${match.scoringMultiplier}`],
    ["允许地图", match.allowedMaps.join(", ") || "（无）"],
    ["允许能力", match.allowedAbilities.join(", ") || "（无）"],
    ["比分", `a ${match.scores.a} : ${match.scores.b} b`],
  ];
  for (const [key, value] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    facts.append(dt, dd);
  }
  card.append(facts);

  if (match.events.length) {
    const list = document.createElement("ul");
    for (const event of match.events) {
      const item = document.createElement("li");
      item.textContent = `#${event.seq} ${event.side} 方 ${event.mapId} +${event.points}（x${event.multiplier}，规则 v${event.packageVersion}）`;
      list.append(item);
    }
    card.append(list);
  }

  const form = document.createElement("form");
  form.className = "row";
  const side = document.createElement("select");
  for (const value of ["a", "b"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} 方`;
    side.append(option);
  }
  const map = document.createElement("select");
  for (const value of match.allowedMaps) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    map.append(option);
  }
  const ability = document.createElement("select");
  ability.append(new Option("（不使用能力）", ""));
  for (const value of match.allowedAbilities) {
    ability.append(new Option(value, value));
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "上报地图结果";
  form.append(side, map, ability, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = await api(`/api/matches/${encodeURIComponent(match.matchId)}/results`, {
        method: "POST",
        body: { side: side.value, mapId: map.value, abilityId: ability.value || undefined },
      });
      showDiagnostics(null);
      renderState(payload.state);
    } catch {
      /* diagnostics already shown in the season-rules panel */
    }
  });
  card.append(form);
  return card;
}

async function refresh() {
  const state = await api("/api/state");
  renderState(state);
}

$("#skip-btn").addEventListener("click", async () => {
  try {
    const payload = await api("/api/skip", { method: "POST", body: { to: $("#skip-to").value } });
    showDiagnostics(null);
    renderState(payload.state);
  } catch { /* shown */ }
});

$("#publish-btn").addEventListener("click", async () => {
  let pkg;
  try {
    pkg = JSON.parse($("#package-json").value);
  } catch (error) {
    showDiagnostics({ error: { code: "UI_JSON", message: `规则包 JSON 无法解析: ${error.message}` } });
    return;
  }
  try {
    const payload = await api("/api/publish", { method: "POST", body: { package: pkg } });
    showDiagnostics(payload);
    renderState(payload.state);
    $("#inspect-result").textContent = JSON.stringify(payload.result, null, 2);
  } catch { /* shown */ }
});

$("#load-scenario").addEventListener("click", async () => {
  const name = $("#scenario-select").value;
  const payload = await api(`/api/scenarios/${encodeURIComponent(name)}`);
  $("#package-json").value = JSON.stringify(payload.package, null, 2);
});

$("#create-match-btn").addEventListener("click", async () => {
  try {
    const payload = await api("/api/matches", { method: "POST", body: { matchId: $("#match-id").value.trim() } });
    showDiagnostics(null);
    renderState(payload.state);
  } catch { /* shown */ }
});

$("#inspect-btn").addEventListener("click", async () => {
  try {
    const payload = await api("/api/inspect", { method: "POST", body: { at: $("#inspect-at").value } });
    showDiagnostics(null);
    $("#inspect-result").textContent = JSON.stringify(payload.inspection, null, 2);
  } catch { /* shown */ }
});

const scenarios = await api("/api/scenarios");
for (const name of scenarios.packages) {
  $("#scenario-select").append(new Option(name, name));
}
await refresh();
