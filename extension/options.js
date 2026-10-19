// Options page: settings, per-site tone, preview, bridge diagnostics and usage.
const $ = (id) => document.getElementById(id);
const SYNC_KEYS = Object.keys(CT_DEFAULTS);
const LOCAL_TEXT_KEYS = ["instructions", "glossary"];
const NUMERIC = new Set(["batchChars", "concurrency"]);
const EXT_VERSION = chrome.runtime.getManifest().version;
let lastHealth = null;

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: { code: "internal", message: String(e?.message || e), action: "" } }));
const fillSelect = (sel, pairs) => {
  sel.replaceChildren(...pairs.map(([v, label]) => { const o = document.createElement("option"); o.value = v; o.textContent = label; return o; }));
};

// ---------- Settings ----------

function modelOptions(available) {
  const avail = available ? new Set(available.map((m) => m.id)) : null;
  const sel = $("model");
  const current = sel.value;
  const pairs = CT_MODELS.map(([id, label]) => [id, avail && !avail.has(id) ? `${label} (이 계정에서 사용 불가)` : label]);
  if (current && !CT_MODELS.some(([id]) => id === current)) pairs.push([current, current]);
  fillSelect(sel, pairs);
  if (current) sel.value = current;
}

async function loadSettings() {
  fillSelect($("tone"), CT_TONES);
  modelOptions(null);
  const s = await chrome.storage.sync.get(CT_DEFAULTS);
  for (const k of SYNC_KEYS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!s[k];
    else {
      if (k === "model" && ![...el.options].some((o) => o.value === s[k])) { modelOptions(null); el.add(new Option(s[k], s[k])); }
      el.value = String(s[k]);
      if (el.tagName === "SELECT" && el.value !== String(s[k])) { // value from an older version
        el.value = String(CT_DEFAULTS[k]);
        chrome.storage.sync.set({ [k]: CT_DEFAULTS[k] });
      }
    }
    el.addEventListener("change", () => {
      let v = el.type === "checkbox" ? el.checked : el.value.trim() || CT_DEFAULTS[k];
      if (NUMERIC.has(k)) v = Number(v);
      chrome.storage.sync.set({ [k]: v });
    });
  }
  const l = await chrome.storage.local.get(CT_LOCAL_DEFAULTS);
  for (const k of LOCAL_TEXT_KEYS) {
    const el = $(k);
    el.value = l[k] || "";
    let timer = 0;
    el.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => chrome.storage.local.set({ [k]: el.value }), 400);
    });
    el.addEventListener("blur", () => { clearTimeout(timer); chrome.storage.local.set({ [k]: el.value }); });
  }
  renderSites(l.siteTone || {});
}

function renderSites(siteTone) {
  const list = $("sites");
  const hosts = Object.keys(siteTone).sort();
  list.replaceChildren(...hosts.map((h) => {
    const li = document.createElement("li");
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = h;
    const tone = document.createElement("span");
    tone.textContent = CT_TONE_LABEL[siteTone[h]] || siteTone[h];
    const del = document.createElement("button");
    del.textContent = "삭제";
    del.addEventListener("click", async () => {
      const { siteTone: cur = {} } = await chrome.storage.local.get({ siteTone: {} });
      delete cur[h];
      await chrome.storage.local.set({ siteTone: cur });
    });
    li.append(host, document.createTextNode("·"), tone, del);
    return li;
  }));
  $("sitesEmpty").hidden = hosts.length > 0;
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.usage) renderUsage();
  if (area === "local" && c.siteTone) renderSites(c.siteTone.newValue || {});
  if (area === "sync") {
    for (const k of ["model", "scope", "tone"]) if (c[k] && $(k)) $(k).value = c[k].newValue;
  }
});

// ---------- Preview ----------

$("previewBtn").addEventListener("click", async () => {
  const btn = $("previewBtn"), out = $("previewOut"), meta = $("previewMeta");
  // Save pending text edits first so the preview uses them.
  await chrome.storage.local.set({ instructions: $("instructions").value, glossary: $("glossary").value });
  btn.disabled = true;
  out.className = "box";
  out.textContent = "번역 중…";
  meta.textContent = "";
  const r = await send({ type: "preview", text: $("sample").value.slice(0, 600) });
  btn.disabled = false;
  if (r?.ok) {
    out.textContent = r.text;
    const u = r.usage;
    meta.textContent = [`${(r.ms / 1000).toFixed(1)}초`, u ? `토큰 입력 ${fmt(u.input)} · 출력 ${fmt(u.output)}` : "", r.model || "", r.notice || ""].filter(Boolean).join(" · ");
  } else {
    const e = r?.fatal || r?.error || {};
    out.className = "box bad";
    out.textContent = [e.message || "미리보기에 실패했어요", e.action].filter(Boolean).join("\n");
  }
});

// ---------- Diagnostics ----------

const AUTH_LABEL = { apiKey: "API 키 로그인", none: "로그인 안 됨", unknown: "로그인 상태 알 수 없음" };
const time = (s) => (s ? new Date(s * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?");

function renderHealth(r) {
  lastHealth = r;
  const el = $("status"), extra = $("statusExtra");
  const lines = [], notes = [];
  if (r?.version) {
    const auth = r.auth || {};
    const login = auth.mode === "chatgpt" ? `ChatGPT 로그인${auth.plan ? `(${auth.plan})` : ""}` : (AUTH_LABEL[auth.mode] || auth.mode || "");
    lines.push(`브리지 v${r.version} · Codex ${r.codexVersion || "?"}${login ? ` · ${login}` : ""}`);
  }
  const err = r?.error;
  if (!r?.ok) {
    if (err) lines.push([err.message, err.action].filter(Boolean).join("\n"));
    else if (!lines.length) lines.push("브리지에 연결할 수 없어요. 터미널에서 install.sh 를 실행하세요.");
  }
  if (r?.version && (r.version !== EXT_VERSION || !(r.features || []).includes("style"))) {
    notes.push("브리지가 오래되었어요 — 터미널에서 install.sh 를 다시 실행하세요");
  }
  if (r?.codexOutdated) notes.push(`Codex ${r.codexVersion}는 테스트되지 않은 오래된 버전이에요: npm i -g @openai/codex@latest`);
  if (r?.selected?.substituted) notes.push(`설정한 모델 대신 ${r.selected.model}을(를) 써요`);
  for (const w of r?.warnings || []) notes.push(w);
  if (r?.sample) {
    const s = r.sample, u = s.usage || {};
    notes.push(s.ok
      ? `샘플 번역: ${s.text} · 첫 응답 ${s.firstTokenMs ?? "?"}ms · 전체 ${s.ms}ms · 토큰 ${fmt(u.input)}/${fmt(u.output)}`
      : `샘플 번역 실패: ${s.error?.message || s.error || "알 수 없음"}`);
  }
  el.className = "box " + (r?.ok ? "ok" : "bad");
  el.textContent = lines.join("\n") || (r?.ok ? "브리지 연결됨" : "브리지 오류");
  extra.replaceChildren(...notes.map((n) => { const d = document.createElement("div"); d.className = "warn"; d.textContent = n; return d; }));
  if (r?.models) modelOptions(r.models);

  const d = {};
  for (const k of ["configTier", "paramsLevel", "procArgs", "removedKeys", "mcpOff", "mcpSeen", "instructionSources", "warnings", "riskyLinks", "threads", "env", "selected", "codexBin", "codexHome", "node", "logFile", "step"]) {
    if (r?.[k] !== undefined) d[k] = r[k];
  }
  if (r?.rateLimits) {
    const rl = r.rateLimits, w = (x) => (x ? `${x.usedPercent}% 사용 · ${time(x.resetsAt)} 초기화` : "-");
    d.rateLimits = { primary: w(rl.primary), secondary: w(rl.secondary) };
  }
  const text = Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
    + (r?.logTail?.length ? `\n\nlogTail:\n${r.logTail.join("\n")}` : "");
  $("detailsPre").textContent = text;
  $("details").hidden = !text.trim();
}

async function runHealth(type, extraMsg = {}) {
  const buttons = ["diagnose", "resetBridge"].map($);
  for (const b of buttons) b.disabled = true;
  $("status").className = "box";
  $("status").textContent = type === "diagnose" ? "진단 중… (Codex 요청 1회)" : "브리지 확인 중…";
  const r = await send({ type, ...extraMsg });
  for (const b of buttons) b.disabled = false;
  renderHealth(r);
}

$("diagnose").addEventListener("click", () => runHealth("diagnose"));
$("resetBridge").addEventListener("click", () => runHealth("health", { reset: true }));
$("copy").addEventListener("click", async () => {
  const text = JSON.stringify({ extensionVersion: EXT_VERSION, userAgent: navigator.userAgent, health: lastHealth }, null, 2);
  try { await navigator.clipboard.writeText(text); $("copy").textContent = "복사했어요"; }
  catch { $("copy").textContent = "복사 실패"; }
  setTimeout(() => { $("copy").textContent = "진단 결과 복사"; }, 1500);
});

// ---------- Usage ----------

async function renderUsage() {
  const { usage = {} } = await chrome.storage.local.get("usage");
  const days = Object.keys(usage).sort().reverse();
  const body = $("usage");
  body.replaceChildren();
  const total = { input: 0, cached: 0, output: 0, batches: 0 };
  const row = (label, u, bold) => {
    const tr = document.createElement("tr");
    for (const v of [label, u.batches, fmt(u.input), fmt(u.cached), fmt(u.output)]) {
      const td = document.createElement("td");
      td.textContent = v;
      if (bold) td.style.fontWeight = "600";
      tr.appendChild(td);
    }
    body.appendChild(tr);
  };
  for (const d of days.slice(0, 14)) row(d, usage[d]);
  for (const d of days) for (const k in total) total[k] += usage[d][k] || 0;
  if (!days.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5; td.textContent = "아직 기록이 없어요"; td.style.textAlign = "left";
    tr.appendChild(td); body.appendChild(tr);
  } else row(`합계 (${days.length}일)`, total, true);
}
$("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove("usage");
  renderUsage();
});

loadSettings().then(() => runHealth("health"));
renderUsage();
