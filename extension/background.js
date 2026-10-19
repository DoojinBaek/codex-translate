importScripts("defaults.js");
// Service worker: injects the content script on demand and relays translation
// requests to the native host (bridge/host.mjs), which drives `codex app-server`.

const HOST = "com.codex_translate.bridge";
const TONE_SOURCE_LABEL = { site: "사이트 지정", global: "전체 설정", auto: "자동" };
const BREAKER_CODES = new Set([
  "unauthorized", "usage_limit", "model_unsupported", "config", "mcp", "codex_missing", "codex_start",
  "codex_crash_loop", "host_missing", "forbidden", "node_missing",
]);
const TIMEOUT_ERROR = {
  code: "timeout", message: "브리지가 응답하지 않아요",
  action: "install.sh 를 다시 실행하고 브라우저를 재시작하세요", retryable: true,
};

async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(CT_DEFAULTS),
    chrome.storage.local.get(CT_LOCAL_DEFAULTS),
  ]);
  const s = { ...sync, ...local };
  // Values left by older versions (e.g. concurrency 16) fall back to the default.
  for (const [k, allowed] of Object.entries(CT_ENUMS)) if (!allowed.includes(s[k])) s[k] = CT_DEFAULTS[k];
  if (typeof s.model !== "string" || !s.model) s.model = CT_DEFAULTS.model;
  if (typeof s.target !== "string" || !s.target.trim()) s.target = CT_DEFAULTS.target;
  if (!s.siteTone || typeof s.siteTone !== "object") s.siteTone = {};
  s.fast = !!s.fast;
  delete s.usage;
  return s;
}

const styleOf = (s) => ({
  tone: s.tone, fidelity: s.fidelity, terms: s.terms,
  instructions: String(s.instructions || ""), glossary: String(s.glossary || ""),
});

// ---- Breaker: after a fatal that retrying cannot fix, fail fast for 60s ----
let breaker = null;
const breakerActive = () => !!breaker && Date.now() < breaker.until;
function trip(fatal) {
  if (fatal && BREAKER_CODES.has(fatal.code)) breaker = { fatal, until: Date.now() + 60000 };
}

// ---- Activation (icon click and Alt+A) ----
async function activate(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;
  breaker = null;
  try { host(); } catch {} // start the bridge and Codex while the page is being scanned
  const target = { tabId };
  const inject = async () => {
    await chrome.scripting.insertCSS({ target, files: ["content.css"] });
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
  };
  let injected = false;
  try {
    const [probe] = await chrome.scripting.executeScript({
      target,
      func: () => { try { return !!window.__codexTranslate?.alive?.(); } catch { return false; } },
    });
    if (probe?.result !== true) { await inject(); injected = true; }
  } catch (e) {
    setBadge(tabId, "!", "#c62828");
    chrome.action.setTitle({ tabId, title: "Codex Translate: 이 페이지에서는 확장을 실행할 수 없어요" }).catch(() => {});
    console.warn("Codex Translate: cannot run on this page", e);
    return;
  }
  const settings = await getSettings();
  try {
    await chrome.tabs.sendMessage(tabId, { type: "toggle", settings });
  } catch (e) {
    if (!injected) {
      try { await inject(); await chrome.tabs.sendMessage(tabId, { type: "toggle", settings }); return; } catch {}
    }
    setBadge(tabId, "!", "#c62828");
    chrome.action.setTitle({ tabId, title: "이 페이지를 새로고침한 뒤 다시 시도하세요" }).catch(() => {});
  }
}
chrome.action.onClicked.addListener((tab) => { activate(tab); });

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ---- Right-click menu on the toolbar icon (6 top-level items max) ----
let menuChain = Promise.resolve();
function buildMenu() {
  menuChain = menuChain.then(buildMenuNow).catch(() => {});
  return menuChain;
}
async function buildMenuNow() {
  await chrome.contextMenus.removeAll();
  const s = await chrome.storage.sync.get(CT_DEFAULTS);
  const C = ["action"];
  const add = (props) => chrome.contextMenus.create({ contexts: C, ...props }, () => void chrome.runtime.lastError);
  add({ id: "m", title: "모델" });
  for (const [id, title] of CT_MODELS) add({ id: `model:${id}`, parentId: "m", title, type: "radio", checked: id === s.model });
  add({ id: "t", title: "문체 (전체)" });
  for (const [id, title] of CT_TONES) add({ id: `tone:${id}`, parentId: "t", title, type: "radio", checked: id === s.tone });
  add({ id: "st", title: "이 사이트 문체" });
  add({ id: "site:inherit", parentId: "st", title: "전체 설정 따르기" });
  for (const [id, title] of Object.entries(CT_TONE_LABEL)) add({ id: `site:${id}`, parentId: "st", title });
  add({ id: "sc", title: "범위" });
  add({ id: "scope:content", parentId: "sc", title: "본문만", type: "radio", checked: s.scope !== "page" });
  add({ id: "scope:page", parentId: "sc", title: "페이지 전체", type: "radio", checked: s.scope === "page" });
  add({ id: "re", title: "현재 설정으로 다시 번역" });
  // Usage lives in one submenu: Chrome allows only 6 top-level items here.
  add({ id: "u", title: "사용량" });
  for (const id of ["u:5h", "u:week", "u:today", "u:page"]) add({ id, parentId: "u", title: "…", enabled: false });
  add({ id: "u:sep", parentId: "u", type: "separator" });
  add({ id: "u:refresh", parentId: "u", title: "Codex 한도 새로고침" });
  add({ id: "options", parentId: "u", title: "설정 및 자세한 사용량…" });
  await updateUsageMenuNow();
}
chrome.runtime.onInstalled.addListener(buildMenu);
chrome.runtime.onStartup.addListener(buildMenu);

async function tabHostname(tab) {
  try { const h = new URL(tab.url).hostname; if (h) return h; } catch {}
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.hostname });
    return r?.result || "";
  } catch { return ""; }
}

async function sendRetranslate(tab) {
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "retranslate", settings: await getSettings() });
    return true;
  } catch { return false; }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  try {
    if (id === "options") chrome.runtime.openOptionsPage();
    else if (id === "u:refresh") refreshLimits();
    else if (id === "re") { if (!(await sendRetranslate(tab))) await activate(tab); }
    else if (id.startsWith("model:")) await chrome.storage.sync.set({ model: id.slice(6) });
    else if (id.startsWith("scope:")) { await chrome.storage.sync.set({ scope: id.slice(6) }); await sendRetranslate(tab); }
    else if (id.startsWith("tone:")) { await chrome.storage.sync.set({ tone: id.slice(5) }); await sendRetranslate(tab); }
    else if (id.startsWith("site:")) {
      const hostname = await tabHostname(tab);
      if (!hostname) return;
      const { siteTone = {} } = await chrome.storage.local.get({ siteTone: {} });
      const tone = id.slice(5);
      if (tone === "inherit") delete siteTone[hostname]; else siteTone[hostname] = tone;
      await chrome.storage.local.set({ siteTone });
      await sendRetranslate(tab);
    }
  } catch {}
});

// ---- Token usage: per tab (tooltip) and per day (options page) ----
const tabInfo = new Map(); // tabId -> {input, output, batches, tone, toneSource}
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function updateTitle(tabId) {
  const t = tabInfo.get(tabId);
  if (!t) return;
  const lines = [];
  lines.push(t.tone
    ? `Codex Translate · 문체: ${CT_TONE_LABEL[t.tone] || t.tone} (${TONE_SOURCE_LABEL[t.toneSource] || "자동"})`
    : "Codex Translate (Option+A)");
  if (t.batches) lines.push(`이 페이지: 입력 ${fmt(t.input)} · 출력 ${fmt(t.output)} 토큰, ${t.batches}개 묶음`);
  chrome.action.setTitle({ tabId, title: lines.join("\n") }).catch(() => {});
}

let usageChain = Promise.resolve();
function recordUsage(tabId, u, model) {
  if (!u) return;
  const add = { input: Number(u.input) || 0, cached: Number(u.cached) || 0, output: Number(u.output) || 0 };
  if (tabId != null) {
    const t = tabInfo.get(tabId) || { input: 0, output: 0, batches: 0 };
    t.input += add.input; t.output += add.output; t.batches++;
    tabInfo.set(tabId, t);
    updateTitle(tabId);
  }
  usageChain = usageChain.then(async () => {
    const day = new Date().toLocaleDateString("sv"); // YYYY-MM-DD
    const { usage = {} } = await chrome.storage.local.get("usage");
    const d = usage[day] || { input: 0, cached: 0, output: 0, batches: 0, models: {} };
    d.input += add.input; d.cached += add.cached; d.output += add.output; d.batches++;
    d.models = d.models || {};
    d.models[model] = (d.models[model] || 0) + 1;
    usage[day] = d;
    const keep = Object.keys(usage).sort().slice(-60); // two months is plenty
    await chrome.storage.local.set({ usage: Object.fromEntries(keep.map((k) => [k, usage[k]])) });
    updateUsageMenu();
    refreshLimits(5_000); // usually already pushed by Codex after the turn; this is the backstop
  }).catch(() => {});
}
// ---- Usage at a glance in the icon menu ----
// Codex plan limits (5-hour / weekly windows, like ChatGPT's usage page) come
// from the bridge; token counts come from what this extension recorded.
async function saveLimits(limits) {
  await chrome.storage.local.set({ limits: { ...limits, at: Date.now() } }).catch(() => {});
  updateUsageMenu();
}

let limitsTimer = 0;
function refreshLimits(delay = 0) {
  clearTimeout(limitsTimer);
  limitsTimer = setTimeout(() => {
    if (breakerActive()) return;
    try {
      request({ type: "limits" }, (r) => {
        handlers.delete(r?.reqId);
        if (r?.limits) saveLimits(r.limits);
      });
    } catch {}
  }, delay);
}

const windowName = (w) => {
  const m = w?.windowDurationMins;
  if (!m) return "한도";
  if (m === 10080) return "주간";
  if (m % 1440 === 0) return `${m / 1440}일`;
  if (m % 60 === 0) return `${m / 60}시간`;
  return `${m}분`;
};
const resetText = (sec) => {
  if (!sec) return "";
  const d = new Date(sec * 1000), now = new Date();
  const hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString() ? `${hm} 초기화` : `${d.getMonth() + 1}/${d.getDate()} ${hm} 초기화`;
};
const limitLine = (w) => `Codex ${windowName(w)} 한도: ${Math.round(w.usedPercent)}% 사용${w.resetsAt ? ` · ${resetText(w.resetsAt)}` : ""}`;

let usageMenuTimer = 0;
function updateUsageMenu() {
  clearTimeout(usageMenuTimer);
  usageMenuTimer = setTimeout(() => { updateUsageMenuNow().catch(() => {}); }, 300);
}
async function updateUsageMenuNow() {
  const { limits, usage = {} } = await chrome.storage.local.get(["limits", "usage"]);
  const today = usage[new Date().toLocaleDateString("sv")];
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const page = tab?.id != null ? tabInfo.get(tab.id) : null;
  const set = (id, props) => chrome.contextMenus.update(id, props, () => void chrome.runtime.lastError);

  const wins = [limits?.primary, limits?.secondary].filter(Boolean);
  const ageMin = limits?.at ? Math.round((Date.now() - limits.at) / 60000) : 0;
  const age = ageMin >= 10 ? ` (${ageMin < 120 ? `${ageMin}분` : `${Math.round(ageMin / 60)}시간`} 전)` : "";
  set("u:5h", wins[0] ? { title: limitLine(wins[0]) + age, visible: true } : { title: "Codex 한도: 아직 정보 없음 (새로고침을 눌러 보세요)", visible: true });
  set("u:week", wins[1] ? { title: limitLine(wins[1]) + age, visible: true } : { visible: false });
  set("u:today", { title: today
    ? `오늘 이 확장: ${today.batches}회 · 입력 ${fmt(today.input)} · 출력 ${fmt(today.output)} 토큰`
    : "오늘 이 확장: 아직 사용 안 함" });
  set("u:page", page?.batches
    ? { title: `이 페이지: ${page.batches}회 · 입력 ${fmt(page.input)} · 출력 ${fmt(page.output)} 토큰`, visible: true }
    : { visible: false });
  const top = wins.length
    ? `사용량 · ${wins.map((w) => `${windowName(w)} ${Math.round(w.usedPercent)}%`).join(" · ")}`
    : today ? `사용량 · 오늘 ${fmt(today.input + today.output)} 토큰` : "사용량";
  set("u", { title: top });
}
chrome.tabs.onActivated.addListener(() => updateUsageMenu());

chrome.tabs.onRemoved.addListener((tabId) => tabInfo.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === "loading") tabInfo.delete(tabId); });

// Any settings change may fix what tripped the breaker. Usage writes do not count.
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (!(area === "local" && keys.length === 1 && keys[0] === "usage")) breaker = null;
  if (area === "sync" && (changes.model || changes.tone || changes.scope)) buildMenu();
});

// ---- Native host connection (one per browser session, multiplexed by reqId) ----
let nativePort = null;
let nextReqId = 1;
let lastHostFatal = null; // {fatal, at}: a fatal without reqId, just before the host exits
const handlers = new Map(); // reqId -> fn(msg)

function fillFatal(f) {
  const fatal = { code: "internal", message: "", action: "", retryable: false, ...f };
  if (fatal.code === "node_missing") {
    fatal.message ||= "node를 찾지 못했어요";
    fatal.action ||= "Node.js 18+ 설치 후 install.sh 를 다시 실행하세요";
  } else if (fatal.code === "codex_missing") {
    fatal.message ||= "codex 실행 파일을 찾지 못했어요";
    fatal.action ||= "npm i -g @openai/codex 후 install.sh 를 다시 실행하세요";
  }
  fatal.message ||= "번역 브리지 오류";
  return fatal;
}

function mapNativeError(text) {
  if (/not found/i.test(text)) {
    return { code: "host_missing", message: "번역 브리지가 이 브라우저에 등록되어 있지 않아요",
      action: "터미널에서 install.sh 를 실행한 뒤 브라우저를 다시 시작하세요", retryable: false };
  }
  if (/forbidden/i.test(text)) {
    return { code: "forbidden", message: "확장 ID가 브리지 등록과 달라요",
      action: "install.sh 가 알려준 폴더의 extension 을 다시 로드하세요", retryable: false };
  }
  return { code: "host_exited", message: "번역 브리지가 종료됐어요",
    action: "~/Library/Logs/codex-translate.log 를 확인하세요", retryable: true };
}

function deliverAll(msg) {
  const fns = [...handlers.values()];
  handlers.clear();
  for (const fn of fns) { try { fn(msg); } catch {} }
}

function host() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST);
  nativePort = port;
  port.onMessage.addListener((msg) => {
    if (msg?.event === "limits") { if (msg.limits) saveLimits(msg.limits); return; }
    if (msg && msg.fatal && msg.reqId == null) {
      const fatal = fillFatal(msg.fatal);
      lastHostFatal = { fatal, at: Date.now() };
      trip(fatal);
      deliverAll({ fatal });
      return;
    }
    handlers.get(msg?.reqId)?.(msg);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "native host disconnected";
    if (nativePort === port) nativePort = null;
    const fatal = lastHostFatal && Date.now() - lastHostFatal.at < 3000 ? lastHostFatal.fatal : mapNativeError(err);
    trip(fatal);
    deliverAll({ fatal });
  });
  return port;
}

// Tests replace this through self.request; every path calls it by its global name.
function request(payload, onMessage) {
  const reqId = nextReqId++;
  handlers.set(reqId, onMessage);
  try {
    host().postMessage({ ...payload, reqId });
  } catch (e) {
    handlers.delete(reqId);
    throw e;
  }
  return reqId;
}

function cancel(reqId) {
  if (reqId == null || !handlers.has(reqId)) return;
  handlers.delete(reqId);
  try { nativePort?.postMessage({ type: "cancel", reqId }); } catch {}
}

// One request with a timeout; resolves with the first message the host sends.
function ask(payload, timeoutMs) {
  return new Promise((resolve) => {
    let reqId = null, finished = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (reqId != null) handlers.delete(reqId);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: TIMEOUT_ERROR }), timeoutMs);
    try { reqId = request(payload, finish); }
    catch (e) { finish({ ok: false, error: mapNativeError(String(e?.message || e)) }); }
  });
}

async function health(deep, reset) {
  const s = await getSettings();
  const r = await ask({
    type: "health", deep: !!deep, reset: !!reset, target: s.target, model: s.model, effort: s.effort, fast: s.fast,
    style: styleOf({ ...s, tone: s.tone === "auto" ? "hamnida" : s.tone }),
  }, deep ? 50000 : 25000);
  if (r && r.fatal && r.ok === undefined) return { ok: false, error: r.fatal };
  if (r?.ok) breaker = null;
  const { reqId: _, ...rest } = r || {};
  return rest;
}

async function preview(text) {
  const s = await getSettings();
  if (breakerActive()) return { ok: false, fatal: breaker.fatal };
  const src = String(text || "").slice(0, 600);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let reqId = null, finished = false, out = null, lineErr = null;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (reqId != null) handlers.delete(reqId);
      resolve(r);
    };
    const timer = setTimeout(() => { cancel(reqId); finish({ ok: false, error: TIMEOUT_ERROR }); }, 40000);
    try {
      reqId = request({
        type: "translate", segments: [{ id: "p1", text: src }], context: "", target: s.target, model: s.model,
        effort: s.effort, fast: s.fast, style: styleOf({ ...s, tone: s.tone === "auto" ? "hamnida" : s.tone }),
      }, (msg) => {
        if (msg.id === "p1") {
          if (msg.keep) out = src;
          else if (typeof msg.text === "string") out = msg.text;
          else if (msg.error) lineErr = { code: msg.code || "error", message: msg.error, action: "", retryable: !!msg.retryable };
          return;
        }
        if (msg.fatal) {
          recordUsage(null, msg.usage, s.model);
          trip(msg.fatal);
          return finish({ ok: false, fatal: msg.fatal });
        }
        if (msg.done) {
          recordUsage(null, msg.usage, msg.model || s.model);
          if (out == null) return finish({ ok: false, fatal: lineErr || { code: "bad_output", message: "번역 결과가 비어 있어요", action: "", retryable: true } });
          finish({ ok: true, text: out, ms: Date.now() - t0, usage: msg.usage || null, model: msg.model, notice: msg.notice });
        }
      });
    } catch (e) {
      finish({ ok: false, fatal: mapNativeError(String(e?.message || e)) });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  switch (msg?.type) {
    case "badge":
      if (tabId != null) setBadge(tabId, msg.text, msg.color);
      return;
    case "status":
      if (tabId != null) {
        const t = tabInfo.get(tabId) || { input: 0, output: 0, batches: 0 };
        t.tone = msg.tone; t.toneSource = msg.toneSource;
        tabInfo.set(tabId, t);
        updateTitle(tabId);
      }
      return;
    case "warm": {
      if (breakerActive()) return;
      const s = { ...CT_DEFAULTS, ...CT_LOCAL_DEFAULTS, ...msg.settings };
      try {
        const id = request({ type: "warm", target: s.target, model: s.model, fast: s.fast, style: styleOf(s) }, () => {});
        handlers.delete(id); // fire and forget: the host never replies
      } catch {}
      return;
    }
    case "health":
      health(false, !!msg.reset).then(reply);
      return true;
    case "diagnose":
      health(true, false).then(reply);
      return true;
    case "preview":
      preview(msg.text).then(reply);
      return true;
  }
});

// One content-script port per batch: {segments} in; {id,text}|{id,keep}|{id,error} then {done}|{fatal} out.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  const tabId = port.sender?.tab?.id;
  let reqId = null, ended = false;
  const post = (m) => { try { port.postMessage(m); } catch {} };
  port.onDisconnect.addListener(() => {
    if (ended) return;
    ended = true;
    cancel(reqId);
  });
  port.onMessage.addListener(({ segments, settings, context }) => {
    if (reqId !== null || ended) return;
    if (breakerActive()) { ended = true; post({ fatal: breaker.fatal }); return; }
    const s = { ...CT_DEFAULTS, ...CT_LOCAL_DEFAULTS, ...settings };
    try {
      reqId = request({
        type: "translate", segments, context, target: s.target, model: s.model, effort: s.effort, fast: s.fast,
        style: styleOf(s),
      }, (msg) => {
        if (ended) return;
        if (msg.done || msg.fatal) {
          ended = true;
          if (msg.reqId != null) handlers.delete(msg.reqId);
          recordUsage(tabId, msg.usage, msg.model || s.model);
          if (msg.fatal) trip(msg.fatal);
        }
        const { reqId: _, ...rest } = msg;
        post(rest);
      });
    } catch (e) {
      ended = true;
      post({ fatal: mapNativeError(String(e?.message || e)) });
    }
  });
});
