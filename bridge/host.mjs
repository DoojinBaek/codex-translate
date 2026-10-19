#!/usr/bin/env node
// Chrome native messaging host. The browser starts this process when the
// extension connects and stops it when the extension disconnects.
// Messages are 4-byte little-endian length + UTF-8 JSON, both directions.
import { translateBatch, getClient, stopClient, health, warm, normStyle, readLimits, onLimits } from "./translator.mjs";
import { BridgeError, toFatal } from "./errors.mjs";
import { parseGlossary } from "./prompt.mjs";
import { log, tail, LOG_FILE } from "./log.mjs";
import { VERSION, FEATURES } from "./version.mjs";

let dead = false; // after a process-level fatal nothing more is sent
function send(obj) {
  if (dead) return;
  try {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
  } catch (e) { log("send failed:", e.message); }
}
process.stdout.on("error", () => shutdown(1));

const requests = new Map(); // reqId -> AbortController

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ac of requests.values()) ac.abort();
  requests.clear();
  try { stopClient(); } catch {}
  setTimeout(() => process.exit(code), 300);
}

process.on("uncaughtException", (e) => {
  log("uncaught:", e?.stack || e?.message || String(e));
  if (e?.code === "EPIPE") return shutdown(1);
  send({ fatal: toFatal(new BridgeError("internal", e?.message || String(e))) });
  dead = true;
  shutdown(1);
});
process.on("unhandledRejection", (e) => log("unhandled rejection:", e?.stack || e?.message || String(e)));

const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function common(msg) {
  const style = normStyle(msg.style);
  return {
    target: (typeof msg.target === "string" ? msg.target.replace(/[\r\n]+/g, " ").trim().slice(0, 40) : "") || "Korean",
    model: typeof msg.model === "string" && MODEL_RE.test(msg.model) ? msg.model : "gpt-6-luna",
    effort: EFFORTS.has(msg.effort) ? msg.effort : "low",
    fast: !!msg.fast,
    style,
  };
}

let crashLoopSentAt = 0;

async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "translate": return onTranslate(msg);
    case "cancel":
      requests.get(msg.reqId)?.abort();
      requests.delete(msg.reqId);
      return;
    case "warm": {
      const o = common(msg);
      warm(o).catch((e) => log("warm:", e.message));
      return;
    }
    case "health": return onHealth(msg);
    case "limits":
      // Plan usage only; this is a plain account read and costs no tokens.
      readLimits()
        .then((limits) => send({ reqId: msg.reqId, limits }))
        .catch((e) => send({ reqId: msg.reqId, limits: null, error: e?.message || String(e) }));
      return;
    case "__crash":
      if (process.env.CODEX_TRANSLATE_TEST === "1") setTimeout(() => { throw new Error("test crash"); });
      return;
  }
}

async function onTranslate(msg) {
  const reqId = msg.reqId;
  const ac = new AbortController();
  requests.set(reqId, ac);
  const o = common(msg);
  const segments = (Array.isArray(msg.segments) ? msg.segments : []).slice(0, 200)
    .filter((s) => s && ID_RE.test(String(s.id)))
    .map((s) => ({ id: String(s.id), text: String(s.text ?? "").slice(0, 4000) }));
  const opts = {
    ...o,
    context: typeof msg.context === "string" ? msg.context.slice(0, 200) : "",
    glossary: parseGlossary(o.style.glossary),
  };
  const t0 = Date.now();
  let outcome = "?";
  let r = { usage: { input: 0, cached: 0, output: 0 } };
  try {
    r = await translateBatch(segments, opts, (m) => { if (!ac.signal.aborted) send({ reqId, ...m }); }, ac.signal);
    if (ac.signal.aborted || r.cancelled) outcome = "cancelled";
    else if (r.fatal) {
      outcome = `fatal:${r.fatal.code}`;
      if (r.fatal.code === "codex_crash_loop") {
        // Applies to every open request: tell the extension once and stop them all.
        if (Date.now() - crashLoopSentAt > 30_000) {
          crashLoopSentAt = Date.now();
          send({ fatal: r.fatal });
          for (const [id, other] of requests) if (id !== reqId) other.abort();
        }
        send({ reqId, fatal: r.fatal, usage: r.usage });
      } else send({ reqId, fatal: r.fatal, usage: r.usage });
    } else {
      outcome = r.notice && /일부 문장/.test(r.notice) ? "partial" : "ok";
      send({ reqId, done: true, usage: r.usage, model: r.model, effort: r.effort, ...(r.notice ? { notice: r.notice } : {}) });
    }
  } catch (e) {
    outcome = "fatal:internal";
    log("translate handler error:", e?.stack || e?.message);
    if (!ac.signal.aborted) send({ reqId, fatal: toFatal(new BridgeError("internal", e?.message || String(e))), usage: r.usage });
  } finally {
    requests.delete(reqId);
  }
  const u = r.usage || {};
  log(`req ${reqId} ${outcome} ${segments.length} segs ${Date.now() - t0}ms ${r.model || o.model}/${r.effort || o.effort}${o.fast ? "/fast" : ""} style=${o.style.tone}/${o.style.fidelity}/${o.style.terms} in=${u.input || 0} cached=${u.cached || 0} out=${u.output || 0}`);
}

async function onHealth(msg) {
  const reqId = msg.reqId;
  const deep = !!msg.deep;
  const stepRef = { step: "start" };
  const limit = deep ? 45_000 : 20_000;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false, version: VERSION, features: FEATURES, node: process.execPath, step: stepRef.step || "start",
      error: { code: "timeout", message: `진단이 '${stepRef.step || "start"}' 단계에서 멈췄어요`, action: "~/Library/Logs/codex-translate.log 를 확인하세요", retryable: true },
    }), limit);
  });
  let res;
  try {
    res = await Promise.race([health({ ...common(msg), deep, reset: !!msg.reset }, stepRef), timeout]);
  } catch (e) {
    res = { ok: false, version: VERSION, features: FEATURES, step: stepRef.step, error: toFatal(new BridgeError("internal", e?.message)) };
  } finally { clearTimeout(timer); }
  send({ reqId, ...res, logFile: LOG_FILE, logTail: tail(20) });
}

onLimits((limits) => send({ event: "limits", limits }));

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len > 64 * 1024 * 1024) {
      log(`frame too large (${len} bytes); dropping input buffer`);
      buf = Buffer.alloc(0);
      break;
    }
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(body.toString("utf8")); }
    catch (e) { log("bad frame:", e.message); continue; }
    handle(msg).catch((e) => log("handler error:", e?.stack || e?.message));
  }
});
process.stdin.on("end", () => shutdown(0));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(0));

log(`native host ${VERSION} pid=${process.pid} node=${process.execPath} codexBin=${process.env.CODEX_BIN || "codex"}`);
getClient().catch((e) => log("codex start failed:", e.code || "", e.message)); // prestart app-server
