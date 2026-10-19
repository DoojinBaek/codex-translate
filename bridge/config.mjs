// Per-thread Codex config that strips the coding-agent payload (~16k tokens of
// tools and instructions) a translator does not need, plus the persisted record
// of which parts this machine's Codex rejected. Nothing here writes to ~/.codex.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.mjs";

export const OFF_FEATURES = [
  "apps", "browser_use", "browser_use_external", "computer_use", "goals", "hooks", "image_generation",
  "memories", "multi_agent", "plugins", "shell_tool", "unified_exec", "skill_search", "tool_suggest",
  "view_image", "sleep_tool", "workspace_dependencies", "worktrees", "in_app_browser", "code_mode_host",
  "mentions_v2", "chronicle", "skill_mcp_dependency_install", "realtime_conversation", "collaboration_modes",
  "web_search_request",
];

export const TIERS = {
  full: {
    ...Object.fromEntries(OFF_FEATURES.map((f) => [`features.${f}`, false])),
    include_permissions_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    include_apps_instructions: false,
    project_doc_max_bytes: 0,
    "skills.bundled.enabled": false,
    "skills.include_instructions": false,
    mcp_optional_startup_grace_ms: 1, // 0 would mean "wait forever" on some versions
  },
  empty: {},
};

export const defaultCodexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const NAME_RE = /^[A-Za-z0-9_-]+$/;

// MCP server names the user configured in config.toml (headers, inline tables, dotted keys).
export function mcpNamesFromToml(codexHome) {
  const names = new Set();
  try {
    const toml = fs.readFileSync(path.join(codexHome || defaultCodexHome(), "config.toml"), "utf8");
    for (const m of toml.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(?:\.[^\]]*)?\]/gm)) names.add(m[1] ?? m[2]);
    for (const sec of toml.matchAll(/^\s*\[\s*mcp_servers\s*\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm)) {
      for (const m of sec[1].matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*\{/gm)) names.add(m[1] ?? m[2]);
    }
    for (const m of toml.matchAll(/^\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\.\S+?\s*=/gm)) names.add(m[1] ?? m[2]);
  } catch {}
  return [...names].filter((n) => NAME_RE.test(n));
}

export function fingerprint(codexVersion, codexHome) {
  let f = "none";
  try {
    const st = fs.statSync(path.join(codexHome || defaultCodexHome(), "config.toml"));
    f = `${st.mtimeMs}:${st.size}`;
  } catch {}
  return `${codexVersion}|${f}`;
}

export const STATE_FILE = process.env.CODEX_TRANSLATE_STATE || path.join(path.dirname(fileURLToPath(import.meta.url)), "state.json");

const defaults = () => ({
  fingerprint: null, procArgs: "unload", tier: "full", paramsLevel: "full",
  removedKeys: [], mcpOff: [], badModels: [], updatedAt: 0,
});

// One shared mutable object; `gen` is in memory only and bumps on every change
// that alters the thread config.
const state = Object.assign(defaults(), { gen: 0 });

function reset(st, keep = {}) {
  const gen = st.gen ?? 0;
  for (const k of Object.keys(st)) delete st[k];
  Object.assign(st, defaults(), keep, { gen: gen + 1 });
}

export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const d = defaults();
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    Object.assign(state, {
      fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : null,
      procArgs: raw.procArgs === "plain" ? "plain" : d.procArgs,
      tier: raw.tier === "empty" ? "empty" : d.tier,
      paramsLevel: raw.paramsLevel === "minimal" ? "minimal" : d.paramsLevel,
      removedKeys: arr(raw.removedKeys),
      mcpOff: arr(raw.mcpOff).filter((n) => NAME_RE.test(n)),
      badModels: (Array.isArray(raw.badModels) ? raw.badModels : []).filter((b) => b && typeof b.model === "string" && b.until > Date.now()),
      updatedAt: raw.updatedAt || 0,
    });
  } catch {}
  return state;
}

export function saveState(st = state) {
  st.updatedAt = Date.now();
  const { gen, ...rest } = st;
  const json = JSON.stringify(rest);
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, json);
  } catch (e) { log("state save failed:", e.message); }
  log(`state: ${json}`);
}

// Codex version or config.toml changed: forget what we learned, except that the
// app-server flag decision holds for the same Codex version.
export function reconcile(fp, st = state) {
  if (st.fingerprint === fp) return false;
  const sameVersion = String(st.fingerprint ?? "").split("|")[0] === String(fp).split("|")[0];
  reset(st, { fingerprint: fp, procArgs: sameVersion ? st.procArgs : "unload" });
  saveState(st);
  return true;
}

export function resetState(st = state) {
  try { fs.unlinkSync(STATE_FILE); } catch {}
  reset(st);
}

const covers = (removed, k) => (removed || []).some((r) => k === r || k.startsWith(r + "."));

export function buildThreadConfig(st = state, mcpNames = []) {
  const cfg = { ...(TIERS[st.tier] || TIERS.full) };
  const removed = st.removedKeys || [];
  for (const name of new Set([...(mcpNames || []), ...(st.mcpOff || [])])) {
    if (!NAME_RE.test(name) || covers(removed, `mcp_servers.${name}`)) continue;
    cfg[`mcp_servers.${name}.enabled`] = false;
  }
  for (const k of Object.keys(cfg)) if (covers(removed, k)) delete cfg[k];
  return { cfg, gen: st.gen ?? 0 };
}

// Adjust state after Codex rejected `cfg` (classify() code config or mcp).
export function degrade(st, cfg, message) {
  st.removedKeys ||= [];
  st.mcpOff ||= [];
  const msg = String(message ?? "");
  // (a) a required MCP server failed: turn it off for our threads
  if (/required MCP servers failed to initialize/i.test(msg)) {
    const name = msg.match(/initialize:\s*([^\s:,]+)/)?.[1];
    if (name && NAME_RE.test(name) && !st.mcpOff.includes(name) && !covers(st.removedKeys, `mcp_servers.${name}`)) {
      st.mcpOff.push(name);
      return "changed";
    }
    return "unfixable";
  }
  // (b) the error names one of our keys: stop sending it. Older messages name an
  // MCP entry without backticks ("invalid transport in mcp_servers.context7").
  const key = msg.match(/in `([^`]+)`/)?.[1] || msg.match(/\b(mcp_servers\.[A-Za-z0-9_-]+)/)?.[1];
  if (key) {
    const isMcp = key.startsWith("mcp_servers.");
    const prefix = isMcp ? key.split(".").slice(0, 2).join(".") : key;
    const hit = Object.keys(cfg || {}).some((k) => k === prefix || k.startsWith(prefix + "."));
    if (hit && !st.removedKeys.includes(prefix)) {
      st.removedKeys.push(prefix);
      if (isMcp) st.mcpOff = st.mcpOff.filter((n) => `mcp_servers.${n}` !== prefix);
      return "changed";
    }
  }
  // An unnamed transport error can only come from our mcp_servers.* overrides.
  if (/invalid transport/i.test(msg) && !st.removedKeys.includes("mcp_servers") && Object.keys(cfg || {}).some((k) => k.startsWith("mcp_servers."))) {
    st.removedKeys.push("mcp_servers");
    st.mcpOff = [];
    return "changed";
  }
  // (c) fall back to sending no config overrides at all
  if (st.tier === "full") { st.tier = "empty"; return "changed"; }
  // (d) last resort: the only overrides left are our mcp_servers.* ones; drop them too.
  if (Object.keys(cfg || {}).some((k) => k.startsWith("mcp_servers.")) && !st.removedKeys.includes("mcp_servers")) {
    st.removedKeys.push("mcp_servers");
    st.mcpOff = [];
    return "changed";
  }
  return "unfixable";
}
