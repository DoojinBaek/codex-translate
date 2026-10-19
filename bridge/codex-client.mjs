// JSON-RPC client for `codex app-server` over stdio.
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import { BridgeError } from "./errors.mjs";
import { log, logOnce } from "./log.mjs";
import { VERSION } from "./version.mjs";

const DEBUG = !!process.env.CODEX_TRANSLATE_DEBUG;
const FORWARD = new Set(["configWarning", "warning", "deprecationNotice", "model/rerouted", "mcpServer/startupStatus/updated", "account/updated", "account/rateLimits/updated"]);
const LATE_TTL_MS = 60_000;

export class CodexClient {
  constructor({ codexBin = "codex", args = [], onNotify, onExit, onRpcTimeout } = {}) {
    this.codexBin = codexBin;
    this.args = args;
    this.onNotify = onNotify;
    this.onExit = onExit;
    this.onRpcTimeout = onRpcTimeout;
    this.nextId = 1;
    this.pending = new Map(); // rpc id -> {resolve, reject, method, timer}
    this.turns = new Map();   // threadId -> active turn
    this.stderrTail = [];
    this.proc = null;
    this.failed = false;
    this.stopping = false;
    this.canUnsubscribe = true;
    this.threadsCreated = 0;
    this.lastTurnActivity = 0;
    this.activeTurns = 0;
    this.codexVersion = null;
    this.info = null;
  }

  get alive() { return !!this.proc && !this.failed && !this.stopping; }

  #cause() {
    const l = [...this.stderrTail].reverse().find((s) => /error|fatal|panic|invalid|failed/i.test(s) && !/unrecognized configuration|is ignored/i.test(s));
    return l ? l.slice(0, 300) : "";
  }

  async start() {
    this.startedAt = Date.now();
    const proc = spawn(this.codexBin, [...this.args, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdin.on("error", (e) => this.#fail(new BridgeError("codex_crash", "stdin: " + e.message)));
    proc.on("error", (e) => this.#fail(new BridgeError(e.code === "ENOENT" ? "codex_missing" : "codex_start", e.message)));
    proc.on("exit", (code, sig) => {
      const cause = this.#cause();
      this.#fail(new BridgeError("codex_crash", `exit ${code ?? sig}${cause ? `: ${cause}` : ""}`));
    });
    proc.stderr.on("data", (d) => {
      for (const raw of String(d).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        if (/ignored|unrecognized/i.test(line)) logOnce("stderr:" + line.replace(/^\S+\s+/, "").slice(0, 200), "[codex]", line.slice(0, 500));
        else if (DEBUG || !/\b(INFO|DEBUG|TRACE)\b/.test(line)) log("[codex]", line.slice(0, 500));
      }
    });
    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
    try {
      const res = await this.request("initialize", {
        clientInfo: { name: "codex-translate", title: "Codex Translate", version: VERSION },
        capabilities: { experimentalApi: false, optOutNotificationMethods: ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta"] },
      }, 20_000);
      this.info = res || {};
      this.codexVersion = String(this.info.userAgent || "").match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] || null;
      this.notify("initialized", {});
    } catch (e) {
      const cause = this.#cause();
      this.stop();
      if (e instanceof BridgeError && e.extra?.rpc) {
        throw new BridgeError("codex_start", `initialize 20초 초과${cause ? `: ${cause}` : ""}`, { initTimeout: true });
      }
      throw e;
    }
  }

  #send(msg) {
    if (!this.alive) throw new BridgeError("codex_crash", "app-server not running");
    if (DEBUG) log(">>", JSON.stringify(msg).slice(0, 300));
    try { this.proc.stdin.write(JSON.stringify(msg) + "\n"); }
    catch (e) { throw new BridgeError("codex_crash", "write: " + e.message); }
  }

  notify(method, params) { this.#send({ method, params }); }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      entry.timer = setTimeout(() => {
        const s = Math.round(timeoutMs / 1000);
        reject(new BridgeError(method === "thread/start" ? "thread_start_timeout" : "timeout", `${method} ${s}s`, { seconds: s, rpc: true }));
        // Keep listening for a late answer so a late thread does not leak.
        const late = {
          method, late: true,
          resolve: (res) => { if (method === "thread/start" && res?.thread?.id) this.unsubscribe(res.thread.id).catch(() => {}); },
          reject: () => {},
          timer: setTimeout(() => this.pending.delete(id), LATE_TTL_MS),
        };
        late.timer.unref?.();
        this.pending.set(id, late);
        try { this.onRpcTimeout?.(method); } catch {}
      }, timeoutMs);
      this.pending.set(id, entry);
      try { this.#send({ id, method, params }); }
      catch (e) { clearTimeout(entry.timer); this.pending.delete(id); reject(e); }
    });
  }

  #onLine(line) {
    if (DEBUG) log("<<", line.slice(0, 300));
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method) {
      // Server -> client request (approvals etc.). A translator never needs tools.
      try { this.#send({ id: msg.id, error: { code: -32601, message: "not supported" } }); } catch {}
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || JSON.stringify(msg.error));
        e.rpcCode = msg.error.code;
        e.data = msg.error.data;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    const method = msg.method;
    const params = msg.params || {};
    if (FORWARD.has(method)) { try { this.onNotify?.(method, params, this); } catch {} }
    const turn = params.threadId ? this.turns.get(params.threadId) : null;
    if (!turn) return;
    this.lastTurnActivity = Date.now();
    turn.touch();
    switch (method) {
      case "item/agentMessage/delta":
        turn.text += params.delta || "";
        if (!turn.firstDeltaAt) { turn.firstDeltaAt = Date.now(); turn.onFirstDelta(); }
        try { turn.onDelta?.(turn.text); } catch (e) { log("onDelta error:", e.message); }
        break;
      case "thread/tokenUsage/updated":
        turn.usage = params.tokenUsage?.last || turn.usage;
        break;
      case "turn/completed": {
        const t = params.turn || {};
        if (t.status === "completed") turn.finish(null, { text: turn.text, usage: turn.usage });
        else if (t.status === "interrupted") turn.finish(turn.forced || new BridgeError("cancelled"));
        else turn.finish(turnError(t.error));
        break;
      }
      case "error":
        if (!params.willRetry) turn.finish(turnError(params.error));
        break;
    }
  }

  async startThread({ system, model, config, serviceTier, paramsLevel = "full" }) {
    const params = paramsLevel === "minimal"
      ? { model, cwd: os.tmpdir(), approvalPolicy: "never", sandbox: "read-only", baseInstructions: system, ephemeral: true, config }
      : { model, serviceTier: serviceTier || null, cwd: os.tmpdir(), approvalPolicy: "never", sandbox: "read-only", baseInstructions: system, developerInstructions: "", ephemeral: true, config };
    const res = await this.request("thread/start", params, 15_000);
    this.threadsCreated++;
    logOnce("instr", "instructionSources", JSON.stringify(res?.instructionSources ?? null));
    return { id: res.thread.id, instructionSources: res.instructionSources || [], model: res.model };
  }

  async runTurn(threadId, { prompt, effort, serviceTier, paramsLevel = "full", signal, onDelta, firstDeltaMs = 20_000, idleMs = 20_000, totalMs = 120_000 }) {
    if (signal?.aborted) throw new BridgeError("cancelled");
    const timers = { first: null, idle: null, total: null, force: null };
    let started = false;
    let settle;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    done.catch(() => {});
    const turn = {
      id: null, text: "", usage: null, firstDeltaAt: 0, forced: null, settled: false, onDelta,
      finish: (err, value) => {
        if (turn.settled) return;
        turn.settled = true;
        if (err) { err.usage = turn.usage; settle.reject(err); } else settle.resolve(value);
      },
      touch: () => {
        if (!started || !turn.firstDeltaAt) return;
        clearTimeout(timers.idle);
        timers.idle = setTimeout(() => force(new BridgeError("timeout", `idle ${idleMs}ms`, { seconds: Math.round(idleMs / 1000) })), idleMs);
      },
      onFirstDelta: () => { clearTimeout(timers.first); turn.touch(); },
    };
    const force = (err) => {
      if (turn.settled || turn.forced) return;
      turn.forced = err;
      if (turn.id) this.request("turn/interrupt", { threadId, turnId: turn.id }, 3_000).catch(() => {});
      // Prefer the interrupted turn/completed (it carries usage); don't wait long for it.
      timers.force = setTimeout(() => turn.finish(err), 3_000);
    };
    const onAbort = () => force(new BridgeError("cancelled"));
    this.turns.set(threadId, turn);
    this.activeTurns++;
    try {
      const params = paramsLevel === "minimal"
        ? { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort }
        : { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort, serviceTier: serviceTier || null, summary: "none" };
      const res = await this.request("turn/start", params, 10_000);
      turn.id = res?.turn?.id || null;
      started = true;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (!turn.firstDeltaAt) {
        timers.first = setTimeout(() => force(new BridgeError("timeout", `first token ${firstDeltaMs}ms`, { seconds: Math.round(firstDeltaMs / 1000) })), firstDeltaMs);
      } else turn.touch();
      timers.total = setTimeout(() => force(new BridgeError("timeout", `total ${totalMs}ms`, { seconds: Math.round(totalMs / 1000) })), totalMs);
      return await done;
    } catch (e) {
      if (e && typeof e === "object" && e.usage === undefined) e.usage = turn.usage;
      throw e;
    } finally {
      for (const t of Object.values(timers)) clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId);
      this.activeTurns--;
    }
  }

  async unsubscribe(id) {
    if (!this.canUnsubscribe || !this.alive) return;
    try { await this.request("thread/unsubscribe", { threadId: id }, 3_000); }
    catch (e) {
      if (e.rpcCode === -32601) { this.canUnsubscribe = false; logOnce("unsub", "thread/unsubscribe unsupported; threads stay loaded"); }
    }
  }

  async #optional(method, params, ms) {
    try { return await this.request(method, params, ms); } catch { return null; }
  }

  async listModels() {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      const res = await this.#optional("model/list", cursor ? { cursor, includeHidden: false } : { includeHidden: false }, 10_000);
      if (!res) return page ? out : null;
      for (const m of res.data || []) {
        out.push({
          id: m.model || m.id,
          efforts: (m.supportedReasoningEfforts || []).map((e) => e?.reasoningEffort ?? e),
          defaultEffort: m.defaultReasoningEffort,
          isDefault: !!m.isDefault,
        });
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  readAccount() { return this.#optional("account/read", { refreshToken: false }, 10_000); }
  readRateLimits() { return this.#optional("account/rateLimits/read", undefined, 5_000); }
  async loadedCount() {
    const res = await this.#optional("thread/loaded/list", { limit: 500 }, 5_000);
    return res ? (res.data || []).length : null;
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError("cancelled")); }
    this.pending.clear();
    for (const t of this.turns.values()) t.finish(new BridgeError("cancelled"));
    try { proc.kill("SIGTERM"); } catch {}
    const k = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2_000);
    k.unref?.();
    proc.once("exit", () => clearTimeout(k));
  }

  #fail(err) {
    if (this.failed) return;
    this.failed = true;
    if (this.stopping) err.intentional = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    for (const t of this.turns.values()) t.finish(err);
    this.turns.clear();
    this.proc = null;
    try { this.onExit?.(err, this.stderrTail.slice()); } catch {}
  }
}

function turnError(te) {
  const e = new Error(te?.message || "turn failed");
  e.codexErrorInfo = te?.codexErrorInfo ?? null;
  if (te?.additionalDetails) e.message += ` (${String(te.additionalDetails).slice(0, 300)})`;
  return e;
}
