// Shared settings and labels. Loaded by background.js (importScripts) and
// options.html. content.js keeps its own FALLBACK_DEFAULTS copy.
self.CT_DEFAULTS = {
  model: "gpt-6-luna",
  effort: "low",
  fast: false,
  target: "Korean",
  mode: "replace",
  batchChars: 1500,
  concurrency: 8,
  scope: "content",
  tone: "auto",
  fidelity: "balanced",
  terms: "auto",
};

// chrome.storage.local (long text and per-site data). "usage" also lives in
// local storage but is never part of the settings object.
self.CT_LOCAL_DEFAULTS = {
  instructions: "",
  glossary: "",
  siteTone: {},
};

self.CT_ENUMS = {
  effort: ["low", "medium", "high"],
  mode: ["replace", "bilingual"],
  batchChars: [600, 1500, 3000],
  concurrency: [4, 6, 8, 12],
  scope: ["content", "page"],
  tone: ["auto", "hamnida", "haeyo", "handa", "casual"],
  fidelity: ["natural", "balanced", "faithful"],
  terms: ["auto", "english", "korean", "both"],
};

// Labels follow Codex's own model catalog, from fastest to most capable.
self.CT_MODELS = [
  ["gpt-6-luna", "gpt-6-luna · 빠르고 가벼움 (권장)"],
  ["gpt-5.6-luna", "gpt-5.6-luna · 빠름, 이전 세대"],
  ["gpt-6.1-sol", "gpt-6.1-sol · 최신 주력, 품질 좋음"],
  ["gpt-6-sol", "gpt-6-sol · 주력, 이전 세대"],
  ["gpt-6-astra", "gpt-6-astra · 최고 성능, 느림"],
];

self.CT_TONES = [
  ["auto", "자동 (사이트에 맞춤)"],
  ["hamnida", "합니다체"],
  ["haeyo", "해요체"],
  ["handa", "한다체 (논문·기사체)"],
  ["casual", "반말"],
];

self.CT_TONE_LABEL = { hamnida: "합니다체", haeyo: "해요체", handa: "한다체", casual: "반말" };
