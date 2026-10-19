// Native messaging owns stdout, so logs go to a file (plus a small in-memory ring
// that the options page can show).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_FILE = process.env.CODEX_TRANSLATE_LOG || path.join(os.homedir(), "Library/Logs/codex-translate.log");

const ring = [];
const seen = new Set();
let writes = 0;
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}

export function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  ring.push(line);
  if (ring.length > 50) ring.shift();
  try {
    if (++writes % 100 === 0 && fs.statSync(LOG_FILE).size > 1_000_000) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
  } catch {}
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

export function logOnce(key, ...parts) {
  if (seen.has(key)) return;
  seen.add(key);
  log(...parts);
}

export function tail(n = 20) {
  return ring.slice(-n);
}
