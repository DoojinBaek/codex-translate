// Translation core for the native host: one long-lived `codex app-server` (the
// user's ChatGPT/Codex login), a small pool of reusable ephemeral threads, and
// recovery from whatever this machine's Codex version or config rejects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CodexClient } from "./codex-client.mjs";
import { BridgeError, classify, toFatal, INFO, message as errMessage } from "./errors.mjs";
import { log, logOnce } from "./log.mjs";
import {
  loadState, saveState, reconcile, resetState, fingerprint, mcpNamesFromToml,
  buildThreadConfig, degrade, defaultCodexHome,
} from "./config.mjs";
import {
  buildSystemPrompt, buildUserMessage, buildRetryMessage, parseReplyLine, isKeep, sane, nameLike, matchGlossary,
} from "./prompt.mjs";
import { VERSION, FEATURES, TESTED_MIN_CODEX, cmpVersion } from "./version.mjs";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const MAX_CONCURRENCY = Number(process.env.CODEX_TRANSLATE_CONCURRENCY) || 16;
export const PRESTART = true; // [P1] idle-thread prestart on "warm"; see test C5

const state = loadState();
let client = null;
let starting = null;
const liveClients = new Set();
let crashTimes = [];
let cooldownUntil = 0;
let lastCrash = "";
let rpcTimeouts = 0;
let lastAuthRestart = 0;
let tierUnsupported = false;
const mcpSeen = new Map();
const warnings = [];
let lastInstructionSources = null;

const addWarning = (w) => {
  w = String(w || "").slice(0, 300);
  if (!w || warnings.includes(w)) return;
  warnings.push(w);
  if (warnings.length > 10) warnings.shift();
};
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new BridgeError("cancelled"));
  const t = setTimeout(() => { signal?.removeEventListener("abort", on); resolve(); }, ms);
  const on = () => { clearTimeout(t); reject(new BridgeError("cancelled")); };
  signal?.addEventListener("abort", on, { once: true });
});
function abortable(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new BridgeError("cancelled"));
  return new Promise((resolve, reject) => {
    const on = () => reject(new BridgeError("cancelled"));
    signal.addEventListener("abort", on, { once: true });
    p.then((v) => { signal.removeEventListener("abort", on); resolve(v); },
      (e) => { signal.removeEventListener("abort", on); reject(e); });
  });
}
const codexHomeOf = (c) => c?.info?.codexHome || defaultCodexHome();

// ---------------------------------------------------------------- app-server

export async function getClient(signal) {
  if (client?.alive) return client;
  if (Date.now() < cooldownUntil) throw new BridgeError("codex_crash_loop", lastCrash);
  starting ||= startFresh().finally(() => { starting = null; });
  return abortable(starting, signal);
}

async function startFresh() {
  const args = state.procArgs === "plain" ? [] : ["-c", "thread_unload_delay_secs=0"];
  let c, plain = !args.length;
  try {
    c = await startOne(args);
  } catch (e) {
    const be = configCrash(classify(e));
    // A hang (initialize timeout) or a missing binary won't be fixed by dropping flags.
    if (!args.length || be.code === "codex_missing" || be.extra?.initTimeout) throw be;
    log(`start with [${args.join(" ")}] failed: ${be.code} ${String(be.detail).slice(0, 300)} | stderr: ${(be.stderr || []).slice(-5).join(" / ")}`);
    try { c = await startOne([]); } catch (e2) { throw configCrash(classify(e2)); }
    plain = true;
  }
  reconcile(fingerprint(c.codexVersion, codexHomeOf(c)));
  if (plain && args.length && state.procArgs !== "plain") { state.procArgs = "plain"; saveState(); }
  c.mcpNames = mcpNamesFromToml(codexHomeOf(c));
  log(`codex ready ${c.info?.userAgent || "?"} home=${codexHomeOf(c)} args=[${c.args.join(" ")}] tier=${state.tier} params=${state.paramsLevel} removed=${JSON.stringify(state.removedKeys)} mcpOff=${JSON.stringify(state.mcpOff)}`);
  client = c;
  c.listModels().then((m) => { c.models = m; log(`models: ${m ? m.map((x) => x.id + (x.isDefault ? "*" : "")).join(",") : "unavailable"}`); });
  c.readAccount().then((a) => { c.account = a; log(`account: ${a?.account?.type || "none"} ${a?.account?.planType || ""} requiresOpenaiAuth=${a?.requiresOpenaiAuth}`); });
  return c;
}

// An app-server that dies at start because of config.toml is a config problem, not a crash.
function configCrash(be) {
  if (be.code !== "codex_crash" && be.code !== "codex_start") return be;
  const inner = classify(new Error(be.detail));
  if (inner.code === "config" || inner.code === "mcp") {
    const out = new BridgeError(inner.code, be.detail, inner.extra);
    out.stderr = be.stderr;
    return out;
  }
  return be;
}

async function startOne(args) {
  const c = new CodexClient({
    codexBin: CODEX_BIN, args,
    onNotify: (method, params) => onNotify(c, method, params),
    onRpcTimeout: (method) => onRpcTimeout(c, method),
    onExit: (err, stderr) => onExit(c, err, stderr),
  });
  c.mcpNames = [];
  liveClients.add(c);
  try {
    await c.start();
  } catch (e) {
    liveClients.delete(c);
    if (e && typeof e === "object") e.stderr = c.stderrTail.slice();
    throw e;
  }
  return c;
}

// ---- Codex plan limits (the "usage" ChatGPT shows): read on demand, kept fresh by notifications ----
let latestLimits = null;
let limitsListener = null;
export function onLimits(fn) { limitsListener = fn; }

const pickWindow = (w) => (w ? { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins ?? null, resetsAt: w.resetsAt ?? null } : null);
function mergeLimits(prev, snap) {
  if (!snap) return prev;
  // Updates are sparse: a missing window keeps the last value we saw.
  return {
    primary: pickWindow(snap.primary) || prev?.primary || null,
    secondary: pickWindow(snap.secondary) || prev?.secondary || null,
    plan: snap.planType || prev?.plan || null,
    reached: snap.rateLimitReachedType ?? prev?.reached ?? null,
  };
}

export async function readLimits() {
  const c = await getClient();
  const rl = await c.readRateLimits();
  if (rl) latestLimits = mergeLimits(null, rl.rateLimitsByLimitId?.codex || rl.rateLimits);
  return latestLimits;
}

function onNotify(c, method, p) {
  switch (method) {
    case "account/rateLimits/updated":
      latestLimits = mergeLimits(latestLimits, p.rateLimits);
      try { limitsListener?.(latestLimits); } catch {}
      break;
    case "configWarning":
      logOnce("cw:" + p.summary, "configWarning:", p.summary, p.details || "");
      addWarning(`config: ${p.summary}${p.details ? ` (${p.details})` : ""}`);
      break;
    case "warning":
      logOnce("w:" + p.message, "warning:", p.message);
      addWarning(p.message);
      break;
    case "deprecationNotice":
      logOnce("d:" + p.summary, "deprecation:", p.summary);
      break;
    case "model/rerouted":
      logOnce(`rr:${p.fromModel}>${p.toModel}`, `model rerouted ${p.fromModel} -> ${p.toModel} (${JSON.stringify(p.reason)})`);
      break;
    case "account/updated":
      log(`account updated: ${p.authMode} ${p.planType}`);
      break;
    case "mcpServer/startupStatus/updated": {
      const name = String(p.name || "");
      mcpSeen.set(name, { name, status: p.status, error: p.error ? String(p.error).slice(0, 300) : null });
      logOnce(`mcp:${name}:${p.status}`, `mcp ${name} ${p.status}${p.error ? `: ${String(p.error).slice(0, 200)}` : ""}`);
      if ((p.status === "starting" || p.status === "ready") && /^[A-Za-z0-9_-]+$/.test(name) && !c.mcpNames.includes(name)
          && !state.removedKeys.some((r) => r === "mcp_servers" || r === `mcp_servers.${name}`)) {
        c.mcpNames.push(name);
        clearPool(true);
      }
      break;
    }
  }
}

function onRpcTimeout(c, method) {
  if (method !== "thread/start" && method !== "turn/start") return;
  rpcTimeouts++;
  if (rpcTimeouts >= 3 && Date.now() - c.lastTurnActivity > 30_000 && client === c) {
    log("restarting wedged app-server");
    restartClient();
    rpcTimeouts = 0;
  }
}

function onExit(c, err, stderr) {
  liveClients.delete(c);
  if (client === c) client = null;
  dropPoolOf(c);
  if (err.intentional) return;
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60_000);
  crashTimes.push(now);
  if (crashTimes.length >= 3) {
    cooldownUntil = now + 30_000;
    lastCrash = err.detail || err.message;
  }
  log(`app-server exited: ${err.message} | ${(stderr || []).slice(-5).join(" / ")}`);
}

function restartClient() {
  const c = client;
  client = null;
  clearPool(false);
  c?.stop();
}

export function stopClient() {
  client = null;
  clearPool(false);
  for (const c of liveClients) c.stop();
  liveClients.clear();
}

// ---------------------------------------------------------------- thread pool

const pool = new Map(); // key -> [{id, turns, lastInput, idleSince, client}]
const keyUse = new Map(); // key -> last use time
let warming = new Map(); // key -> number of threads being prestarted

function clearPool(unsubscribe) {
  for (const arr of pool.values()) for (const th of arr) if (unsubscribe) th.client?.unsubscribe?.(th.id)?.catch?.(() => {});
  pool.clear();
}
function dropPoolOf(c) {
  for (const [k, arr] of pool) {
    const rest = arr.filter((th) => th.client !== c);
    if (rest.length) pool.set(k, rest); else pool.delete(k);
  }
}

function threadKey(model, system, serviceTier, cfg) {
  return createHash("sha1").update(`${model}\0${system}\0${serviceTier || ""}\0${JSON.stringify(cfg)}`).digest("hex");
}

async function acquireThread(c, { system, model, serviceTier }, signal) {
  c.gateGen ??= -1;
  c.gateLock ??= Promise.resolve();
  c.gateErr ??= null;
  const key = threadKey(model, system, serviceTier, buildThreadConfig(state, c.mcpNames).cfg);
  keyUse.set(key, Date.now());
  const arr = pool.get(key);
  while (arr?.length) {
    const th = arr.pop();
    if (th.client === c) return { ...th, key, client: c, batchTurns: 0 };
  }
  let r = null;
  if (c.gateGen !== state.gen) {
    // Only one thread/start at a time while the config is unproven, so a config
    // error degrades the state once instead of once per parallel batch.
    const prev = c.gateLock;
    let release;
    const mine = new Promise((res) => { release = res; });
    c.gateLock = prev.then(() => mine);
    try {
      await abortable(prev, signal);
      if (c.gateGen !== state.gen) {
        if (c.gateErr && c.gateErr.gen === state.gen && Date.now() - c.gateErr.at < 5_000) throw c.gateErr.err;
        try {
          r = await startThreadDegrading(c, { system, model, serviceTier });
          c.gateGen = state.gen;
          c.gateErr = null;
        } catch (e) {
          c.gateErr = { gen: state.gen, at: Date.now(), err: e };
          throw e;
        }
      }
    } finally { release(); }
  }
  if (!r) r = await startThreadDegrading(c, { system, model, serviceTier });
  const realKey = threadKey(model, system, serviceTier, r.cfg);
  return { id: r.id, key: realKey, client: c, turns: 0, batchTurns: 0, lastInput: 0 };
}

async function startThreadDegrading(c, { system, model, serviceTier }) {
  let lastBe = null;
  for (let i = 0; i < 12; i++) {
    const { cfg, gen } = buildThreadConfig(state, c.mcpNames);
    try {
      const r = await c.startThread({ system, model, config: cfg, serviceTier, paramsLevel: state.paramsLevel });
      rpcTimeouts = 0;
      if (r.instructionSources) lastInstructionSources = r.instructionSources;
      return { ...r, cfg };
    } catch (e) {
      let be = configCrash(classify(e));
      lastBe = be;
      if (be.code === "params" && state.paramsLevel === "full") {
        state.paramsLevel = "minimal"; state.gen++; saveState();
        log(`thread/start params rejected (${String(e.message).slice(0, 200)}); using minimal params`);
        continue;
      }
      // Minimal params still rejected: the offending field must be in our config.
      if (be.code === "params") be = new BridgeError("config", be.detail);
      if (be.code === "config" || be.code === "mcp") {
        if (gen !== state.gen) continue; // someone else already degraded
        const r = degrade(state, cfg, e.message || be.detail);
        if (r === "changed") {
          state.gen++; saveState(); clearPool(true);
          log(`config degraded: ${String(e.message || be.detail).slice(0, 300)} -> tier=${state.tier} removed=${JSON.stringify(state.removedKeys)} mcpOff=${JSON.stringify(state.mcpOff)}`);
          // The app-server died from the bad config: retry on a fresh one.
          if (!c.alive) throw new BridgeError("codex_crash", be.detail);
          continue;
        }
        throw be;
      }
      throw be;
    }
  }
  throw lastBe || new BridgeError("config", "too many config retries");
}

function releaseThread(th, healthy) {
  if (!th) return;
  const c = th.client;
  if (healthy && c === client && c?.alive && th.turns < 3 && th.lastInput < 12_000) {
    const arr = pool.get(th.key) || [];
    arr.push({ id: th.id, turns: th.turns, lastInput: th.lastInput, idleSince: Date.now(), client: c });
    while (arr.length > 8) { const old = arr.shift(); c.unsubscribe(old.id).catch(() => {}); }
    pool.set(th.key, arr);
  } else {
    c?.unsubscribe?.(th.id)?.catch?.(() => {});
  }
  if (c && c === client && !c.canUnsubscribe && c.threadsCreated >= 64 && c.activeTurns === 0) {
    log("restarting app-server to unload threads (no thread/unsubscribe)");
    restartClient();
  }
}

const sweeper = setInterval(() => {
  const now = Date.now();
  const recent = [...keyUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  for (const [k, arr] of pool) {
    const maxIdle = recent.includes(k) ? 600_000 : 60_000;
    const keep = [];
    for (const th of arr) {
      if (now - th.idleSince > maxIdle) th.client?.unsubscribe(th.id).catch(() => {});
      else keep.push(th);
    }
    if (keep.length) pool.set(k, keep); else pool.delete(k);
  }
  for (const [k, t] of keyUse) if (now - t > 3_600_000) keyUse.delete(k);
}, 60_000);
sweeper.unref?.();

// [P1] Start idle threads for the page's style before its first batch arrives.
export async function warm({ target, model, fast, style }) {
  if (!PRESTART) return;
  try {
    const c = await getClient();
    const resolved = resolveModel(model, "low", c.models);
    const system = buildSystemPrompt(target, style);
    const serviceTier = fast && !tierUnsupported ? "priority" : null;
    const key = threadKey(resolved.model, system, serviceTier, buildThreadConfig(state, c.mcpNames).cfg);
    keyUse.set(key, Date.now());
    const idle = (pool.get(key) || []).filter((t) => t.client === c).length;
    const n = Math.max(0, 4 - idle - (warming.get(key) || 0));
    for (let i = 0; i < n; i++) {
      warming.set(key, (warming.get(key) || 0) + 1);
      acquireThread(c, { system, model: resolved.model, serviceTier })
        .then((th) => releaseThread(th, true))
        .catch((e) => log(`warm failed: ${e.code || ""} ${String(e.message).slice(0, 200)}`))
        .finally(() => { const w = (warming.get(key) || 1) - 1; if (w) warming.set(key, w); else warming.delete(key); });
    }
  } catch (e) { log(`warm failed: ${e.code || ""} ${String(e.message).slice(0, 200)}`); }
}

// ---------------------------------------------------------------- slots

let slotsUsed = 0;
const waiters = [];
async function withSlot(signal, fn) {
  if (slotsUsed >= MAX_CONCURRENCY) {
    await new Promise((resolve, reject) => {
      const w = { resolve, reject: null };
      const on = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new BridgeError("cancelled")); };
      w.resolve = () => { signal?.removeEventListener("abort", on); resolve(); };
      if (signal?.aborted) return on();
      signal?.addEventListener("abort", on, { once: true });
      waiters.push(w);
    });
  } else slotsUsed++;
  // A waiter inherits the releasing batch's slot, so slotsUsed is unchanged here.
  try {
    if (signal?.aborted) throw new BridgeError("cancelled");
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next.resolve(); else slotsUsed--;
  }
}

// ---------------------------------------------------------------- models

export function resolveModel(requested, effort, models) {
  if (!models || !models.length) return { model: requested, effort, substituted: false };
  const now = Date.now();
  const bad = new Set(state.badModels.filter((b) => b.until > now).map((b) => b.model));
  const list = models.filter((m) => !bad.has(m.id));
  const fam = String(requested).match(/luna|sol|astra/i)?.[0]?.toLowerCase();
  const m = list.find((x) => x.id === requested)
    || (fam && list.find((x) => x.id.toLowerCase().includes(fam)))
    || list.find((x) => x.isDefault)
    || list[0];
  if (!m) return { model: requested, effort, substituted: false };
  const efforts = m.efforts || [];
  const eff = !efforts.length || efforts.includes(effort) ? effort : efforts.includes("low") ? "low" : (m.defaultEffort || effort);
  return { model: m.id, effort: eff, substituted: m.id !== requested };
}

const effortTimeout = (e) => (/^(none|minimal|low)$/.test(e) ? 20_000 : e === "medium" ? 45_000 : 90_000);
const substText = (from, to) => `${from}을(를) 쓸 수 없어 ${to}(으)로 번역했어요`;

// ---------------------------------------------------------------- translate

// Streams {id,text} | {id,keep:true} | {id,error,code,retryable} to emit.
// Returns {usage, model, effort, notice} | {usage, fatal} | {usage, cancelled:true}.
export async function translateBatch(segments, opts, emit, signal) {
  const want = new Map(segments.map((s) => [String(s.id), s]));
  const usage = { input: 0, cached: 0, output: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usage.input += u.inputTokens || 0;
    usage.cached += u.cachedInputTokens || 0;
    usage.output += u.outputTokens || 0;
  };
  let ok = 0;
  const put = (id, msg) => {
    if (!want.has(id)) return false;
    want.delete(id);
    ok++;
    try { emit({ id, ...msg }); } catch {}
    return true;
  };
  const system = buildSystemPrompt(opts.target, opts.style);
  let serviceTier = opts.fast && !tierUnsupported ? "priority" : null;
  let attempts = 0, timeouts = 0, badTurns = 0;
  const free = { model: 0, tier: 0, auth: 0 };
  let thread = null, notice = null, lastErr = null, resolved = { model: opts.model, effort: opts.effort };
  let c = null;
  const fatal = (be) => {
    if (thread) { releaseThread(thread, false); thread = null; }
    return { usage, fatal: toFatal(be, { codexVersion: c?.codexVersion }) };
  };

  while (want.size && attempts < 3) {
    if (signal?.aborted) return { usage, cancelled: true };
    attempts++;
    try {
      c = await getClient(signal);
      resolved = resolveModel(opts.model, opts.effort, c.models);
      if (resolved.substituted && !notice) notice = substText(opts.model, resolved.model);
      await withSlot(signal, async () => {
        if (!thread || thread.client !== client) {
          if (thread) releaseThread(thread, false);
          thread = await acquireThread(c, { system, model: resolved.model, serviceTier }, signal);
        }
        if (signal?.aborted) throw new BridgeError("cancelled");
        const rem = segments.filter((s) => want.has(String(s.id)));
        const gl = matchGlossary(opts.glossary || [], rem.map((s) => s.text));
        const prompt = thread.batchTurns === 0
          ? buildUserMessage(rem, { title: opts.context, glossaryPairs: gl })
          : buildRetryMessage(rem, { glossaryPairs: gl });
        let consumed = 0, got = 0;
        const take = (text, final) => {
          const lines = text.split("\n");
          const upto = final ? lines.length : lines.length - 1; // the last line may still be growing
          for (let i = consumed; i < upto; i++) {
            const r = parseReplyLine(lines[i]);
            if (!r || !want.has(r.id)) continue;
            const src = want.get(r.id).text;
            if (isKeep(r.text, src)) { if (put(r.id, { keep: true })) got++; }
            else if (sane(r.text, src)) { if (put(r.id, { text: r.text })) got++; }
          }
          consumed = Math.max(consumed, upto);
        };
        const base = effortTimeout(resolved.effort);
        const r = await c.runTurn(thread.id, {
          prompt, effort: resolved.effort, serviceTier, paramsLevel: state.paramsLevel, signal,
          onDelta: (text) => take(text, false),
          firstDeltaMs: base * (timeouts ? 1.5 : 1),
          totalMs: Math.min(240_000, base + 30_000 + 40 * prompt.length),
        });
        rpcTimeouts = 0;
        take(r.text || "", true);
        addUsage(r.usage);
        thread.turns++;
        thread.batchTurns++;
        thread.lastInput = r.usage?.inputTokens || 0;
        if (got === 0) badTurns++;
      });
      for (const [id, s] of want) if (nameLike(s.text)) put(id, { keep: true });
      if (badTurns >= 2) { lastErr = new BridgeError("bad_output"); break; }
      if (want.size) log(`missing ${want.size} line(s): ${[...want.keys()].slice(0, 10).join(",")}`);
    } catch (e) {
      let be = classify(e);
      addUsage(e?.usage);
      if (thread) { releaseThread(thread, false); thread = null; }
      if (be.code === "cancelled") {
        if (signal?.aborted) return { usage, cancelled: true };
        be = new BridgeError("timeout", "interrupted", { seconds: Math.round(effortTimeout(resolved.effort) / 1000) });
      }
      lastErr = be;
      log(`attempt ${attempts} ${be.code} ${String(be.detail || be.message).slice(0, 300)}`);
      switch (be.code) {
        case "timeout":
          timeouts++;
          if (timeouts >= 2) break;
          continue;
        case "model_unsupported": {
          if (free.model++ >= 2) return fatal(withModel(be, resolved.model));
          state.badModels.push({ model: resolved.model, until: Date.now() + 86_400_000 });
          saveState();
          if (c && !c.models) c.models = await c.listModels();
          const next = resolveModel(opts.model, opts.effort, c?.models);
          if (next.model !== resolved.model) {
            notice = substText(opts.model, next.model);
            attempts--;
            continue;
          }
          return fatal(withModel(be, resolved.model));
        }
        case "tier_unsupported":
          tierUnsupported = true;
          serviceTier = null;
          attempts--;
          continue;
        case "params":
          if (free.tier++ < 1) {
            state.paramsLevel = "minimal"; state.gen++; saveState();
            attempts--;
            continue;
          }
          return fatal(be);
        case "unauthorized":
          if (free.auth++ < 1 && Date.now() - lastAuthRestart > 300_000) {
            lastAuthRestart = Date.now();
            restartClient();
            attempts--;
            continue;
          }
          return fatal(be);
        case "usage_limit": {
          const rl = await client?.readRateLimits?.().catch?.(() => null);
          const resetAt = usageResetAt(rl);
          if (resetAt) be.extra.resetAt = resetAt;
          return fatal(be);
        }
        case "network": case "server": case "rate_limited": case "codex_crash":
        case "context_full": case "thread_start_timeout": case "unsupported_method":
          if (be.code === "thread_start_timeout") be.extra.riskyLinks = riskyLinks(codexHomeOf(c));
          try { await sleep(be.code === "rate_limited" ? 3_000 : 500 * attempts, signal); }
          catch { return { usage, cancelled: true }; }
          continue;
        case "policy":
          for (const id of [...want.keys()]) {
            want.delete(id);
            try { emit({ id, error: INFO.policy.message(), code: "policy", retryable: false }); } catch {}
          }
          return { usage, model: resolved.model, effort: resolved.effort, notice };
        default:
          return fatal(be);
      }
      break; // only reached from the timeout case
    }
  }

  if (thread) releaseThread(thread, badTurns < 2);
  if (!want.size) return { usage, model: resolved.model, effort: resolved.effort, notice };
  if (ok === 0 && lastErr) return { usage, fatal: toFatal(lastErr, { codexVersion: c?.codexVersion }) };
  const msg = lastErr ? errMessage(lastErr.code, lastErr.detail, lastErr.extra) : "번역 결과에서 빠졌어요";
  const n = want.size;
  for (const id of [...want.keys()]) {
    try { emit({ id, error: msg, code: lastErr?.code || "bad_output", retryable: true }); } catch {}
  }
  if (lastErr) notice = notice || `일부 문장(${n}개)을 번역하지 못했어요: ${msg}`;
  return { usage, model: resolved.model, effort: resolved.effort, notice };
}

function withModel(be, model) {
  be.extra = { ...be.extra, model: be.extra?.model || model };
  return be;
}

function usageResetAt(rl) {
  if (!rl) return null;
  const snaps = [rl.rateLimits, ...Object.values(rl.rateLimitsByLimitId || {})].filter(Boolean);
  let latest = 0;
  for (const s of snaps) for (const w of [s.primary, s.secondary]) {
    if (w && w.usedPercent >= 100 && w.resetsAt > latest) latest = w.resetsAt;
  }
  if (!latest) return null;
  return new Date(latest * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Symlinks in CODEX_HOME that point at places a browser-launched process may not
// be allowed to read (external drives, TCC-protected folders). Never follows them.
export function riskyLinks(codexHome) {
  const home = os.homedir();
  const risky = ["/Volumes/", `${home}/Documents`, `${home}/Desktop`, `${home}/Downloads`, `${home}/Library/Mobile Documents`];
  const out = [];
  const shown = codexHome === path.join(home, ".codex") ? "~/.codex" : String(codexHome).replace(home, "~");
  for (const dir of ["skills", "plugins", "."]) {
    const base = path.join(codexHome, dir);
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) {
      try {
        const p = path.join(base, name);
        if (!fs.lstatSync(p).isSymbolicLink()) continue;
        const target = path.resolve(base, fs.readlinkSync(p));
        if (risky.some((r) => target === r.replace(/\/$/, "") || target.startsWith(r.endsWith("/") ? r : r + "/"))) {
          out.push(dir === "." ? `${shown}/${name}` : `${shown}/${dir}/${name}`);
          if (out.length >= 5) return out;
        }
      } catch {}
    }
  }
  return out;
}

// ---------------------------------------------------------------- health

export async function health({ deep = false, reset = false, target = "Korean", model = "gpt-6-luna", effort = "low", fast = false, style } = {}, stepRef = {}) {
  const out = {
    ok: false, version: VERSION, features: FEATURES, node: process.execPath, codexBin: CODEX_BIN,
    codexVersion: null, codexOutdated: false, codexHome: null,
    env: envInfo(),
    auth: { mode: "unknown", plan: null, ok: false }, rateLimits: null, models: null, selected: null,
    configTier: state.tier, procArgs: state.procArgs, paramsLevel: state.paramsLevel,
    removedKeys: state.removedKeys.slice(), mcpOff: state.mcpOff.slice(), mcpSeen: [...mcpSeen.values()],
    instructionSources: lastInstructionSources || [], warnings: warnings.slice(), riskyLinks: [],
    threads: threadStats(null, null),
  };
  if (reset) {
    resetState();
    restartClient();
    tierUnsupported = false;
    log("bridge state reset");
  }
  try {
    stepRef.step = "start";
    const c = await getClient();
    out.codexVersion = c.codexVersion;
    out.codexOutdated = !!c.codexVersion && cmpVersion(c.codexVersion, TESTED_MIN_CODEX) < 0;
    out.codexHome = codexHomeOf(c);
    out.riskyLinks = riskyLinks(out.codexHome);

    stepRef.step = "account";
    const acct = await c.readAccount();
    if (acct) c.account = acct;
    const a = acct?.account;
    const mode = a?.type || (acct?.requiresOpenaiAuth ? "none" : "unknown");
    out.auth = { mode, plan: a?.planType ?? null, ok: mode === "chatgpt" || mode === "apiKey" };
    if (mode === "apiKey") addWarning("API 키로 로그인되어 있어 토큰당 요금이 나가요");
    const rl = await c.readRateLimits();
    if (rl?.rateLimits) {
      const w = (x) => (x ? { usedPercent: x.usedPercent, resetsAt: x.resetsAt } : null);
      out.rateLimits = { primary: w(rl.rateLimits.primary), secondary: w(rl.rateLimits.secondary) };
    }

    stepRef.step = "models";
    const models = await c.listModels();
    if (models) c.models = models;
    out.models = models ? models.map(({ id, efforts, isDefault }) => ({ id, efforts, isDefault })) : null;
    const sel = resolveModel(model, effort, c.models);
    out.selected = { model: sel.model, effort: sel.effort, substituted: sel.substituted };

    stepRef.step = "threads";
    out.threads = threadStats(c, await c.loadedCount());

    if (deep) {
      stepRef.step = "sample";
      const src = "Hello! This is a short test of the translator.";
      const t0 = Date.now();
      let first = null, text = "", err = null;
      const r = await translateBatch([{ id: "t1", text: src }],
        { target, model, effort, fast, context: "", style: normStyle(style), glossary: [] },
        (m) => {
          if (first == null) first = Date.now() - t0;
          if (m.text) text = m.text; else if (m.keep) text = src; else if (m.error) err = { code: m.code, message: m.error };
        });
      const sample = { ok: !!text && !r.fatal, ms: Date.now() - t0, firstTokenMs: first, text, usage: r.usage };
      if (r.fatal) sample.error = r.fatal; else if (err) sample.error = err;
      out.sample = sample;
      out.threads = threadStats(c, await c.loadedCount());
    }
    stepRef.step = null;
    out.ok = out.auth.ok && (!deep || !!out.sample?.ok);
    if (!out.auth.ok) out.error = toFatal(new BridgeError("unauthorized"), { codexVersion: c.codexVersion });
    else if (deep && !out.sample?.ok && out.sample?.error?.action !== undefined) out.error = out.sample.error;
  } catch (e) {
    const be = classify(e);
    out.step = stepRef.step || "start";
    out.error = toFatal(be, { codexVersion: out.codexVersion });
  }
  Object.assign(out, {
    configTier: state.tier, procArgs: state.procArgs, paramsLevel: state.paramsLevel,
    removedKeys: state.removedKeys.slice(), mcpOff: state.mcpOff.slice(), mcpSeen: [...mcpSeen.values()],
    instructionSources: lastInstructionSources || [], warnings: warnings.slice(),
  });
  return out;
}

function threadStats(c, loaded) {
  let idle = 0;
  for (const arr of pool.values()) idle += arr.length;
  return {
    idle, active: c?.activeTurns ?? client?.activeTurns ?? 0, created: c?.threadsCreated ?? client?.threadsCreated ?? 0,
    loaded: loaded ?? null, canUnsubscribe: c?.canUnsubscribe ?? client?.canUnsubscribe ?? true,
  };
}

function envInfo() {
  const e = process.env;
  const names = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
  const proxy = [];
  for (const n of names) for (const v of [n, n.toLowerCase()]) if (e[v]) proxy.push(v);
  return { codexHomeSet: !!e.CODEX_HOME, proxy, caCerts: !!(e.NODE_EXTRA_CA_CERTS || e.SSL_CERT_FILE) };
}

const TONES = new Set(["hamnida", "haeyo", "handa", "casual"]);
const FIDS = new Set(["natural", "balanced", "faithful"]);
const TERMSET = new Set(["auto", "english", "korean", "both"]);
export function normStyle(s = {}) {
  s = s && typeof s === "object" ? s : {};
  return {
    tone: TONES.has(s.tone) ? s.tone : "hamnida",
    fidelity: FIDS.has(s.fidelity) ? s.fidelity : "balanced",
    terms: TERMSET.has(s.terms) ? s.terms : "auto",
    instructions: typeof s.instructions === "string" ? s.instructions.slice(0, 1000) : "",
    glossary: typeof s.glossary === "string" ? s.glossary.slice(0, 4000) : "",
  };
}

export const _test = {
  acquireThread,
  state: () => state,
  setClientForTest: (c) => { client = c; c.mcpNames ??= []; },
  buildThreadConfig,
  resolveModel,
  releaseThread,
  pool: () => pool,
};
