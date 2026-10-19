export const VERSION = "0.4.1";
export const FEATURES = ["style", "keep", "fatal2", "pool", "diagnose", "reset", "limits"];
export const TESTED_MIN_CODEX = "0.160.0";

// Compares numeric x.y.z (suffixes like -alpha are ignored). Returns -1, 0 or 1.
export function cmpVersion(a, b) {
  const parse = (v) => String(v ?? "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
