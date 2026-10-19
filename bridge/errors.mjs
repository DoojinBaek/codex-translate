// Error codes shared by the bridge. message/action are Korean and shown to the user.
import { cmpVersion, TESTED_MIN_CODEX } from "./version.mjs";

export class BridgeError extends Error {
  constructor(code, detail = "", extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = String(detail ?? "").slice(0, 200);
    this.extra = extra || {};
  }
}

const LOG_HINT = "~/Library/Logs/codex-translate.log 를 확인하세요";

export const INFO = {
  cancelled: { retryable: true, breaker: false, message: () => "취소됐어요", action: () => "" },
  timeout: {
    retryable: true, breaker: false,
    message: (d, x) => `Codex가 ${x.seconds ?? ""}초 동안 응답하지 않았어요`,
    action: () => "네트워크를 확인하세요. 잠시 뒤 자동으로 다시 시도해요",
  },
  network: { retryable: true, breaker: false, message: () => "Codex 서버에 연결하지 못했어요", action: () => "인터넷 연결(프록시·VPN 포함)을 확인하세요" },
  server: { retryable: true, breaker: false, message: () => "Codex 서버 오류(일시적)예요", action: () => "잠시 뒤 Option+A 로 다시 시도하세요" },
  rate_limited: { retryable: true, breaker: false, message: () => "요청이 너무 잦아요", action: () => "잠시 뒤 다시 시도하세요" },
  thread_start_timeout: {
    retryable: true, breaker: false,
    message: () => "Codex 작업을 시작하지 못했어요(15초 초과)",
    action: (x) => x.riskyLinks?.length
      ? `~/.codex 안의 링크(${x.riskyLinks.join(", ")})가 외장 드라이브나 보호된 폴더를 가리켜요. 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더에서 이 브라우저에 접근을 허용하거나 링크를 옮기세요`
      : "잠시 뒤 다시 시도하세요. 계속되면 설정 페이지의 '진단 실행'을 눌러 보세요",
  },
  codex_crash: {
    retryable: true, breaker: false,
    message: (d) => `Codex app-server가 종료됐어요: ${d}`,
    action: () => "자동으로 다시 시작해요. 계속되면 ~/Library/Logs/codex-translate.log 를 확인하세요",
  },
  codex_crash_loop: {
    retryable: false, breaker: true,
    message: (d) => `Codex app-server가 계속 종료돼요: ${d}`,
    action: () => "터미널에서 codex app-server 를 직접 실행해 오류를 확인하거나 로그를 확인하세요",
  },
  bad_output: {
    retryable: true, breaker: false,
    message: () => "Codex 응답 형식이 맞지 않아요",
    action: () => "설정의 '추가 지시'나 ~/.codex/AGENTS.md 의 출력 형식 지시를 확인하세요",
  },
  internal: { retryable: true, breaker: false, message: (d) => `번역 브리지 내부 오류: ${d}`, action: () => LOG_HINT },
  policy: { retryable: false, breaker: false, message: () => "이 문장은 번역이 거부됐어요", action: () => "" },
  bad_request: {
    retryable: false, breaker: false,
    message: (d) => `Codex가 요청을 거부했어요: ${d}`,
    action: () => "설정에서 모델이나 추론 강도를 바꿔 보세요",
  },
  unauthorized: {
    retryable: false, breaker: true,
    message: () => "Codex 로그인이 만료됐거나 로그아웃 상태예요",
    action: () => "터미널에서 codex login 을 실행한 뒤 Option+A 를 다시 누르세요",
  },
  usage_limit: {
    retryable: false, breaker: true,
    message: (d, x) => `ChatGPT/Codex 사용 한도에 도달했어요${x.resetAt ? ` (${x.resetAt} 이후 초기화)` : ""}`,
    action: () => "한도가 초기화된 뒤 다시 시도하거나 설정에서 더 가벼운 모델을 고르세요",
  },
  model_unsupported: {
    retryable: false, breaker: true,
    message: (d, x) => `모델 ${x.model || "?"}을(를) 이 계정이나 Codex 버전에서 쓸 수 없어요`,
    action: () => "설정에서 다른 모델을 고르세요",
  },
  config: {
    retryable: false, breaker: true,
    message: (d) => `Codex 설정(~/.codex/config.toml) 오류: ${d}`,
    action: () => "config.toml 을 고치거나 터미널에서 codex 를 한 번 실행해 오류를 확인하세요",
  },
  mcp: {
    retryable: false, breaker: true,
    message: (d, x) => `필수 MCP 서버 ${x.name || "?"}을(를) 시작하지 못했어요`,
    action: () => "~/.codex/config.toml 에서 그 서버의 required = true 를 지우세요",
  },
  codex_missing: {
    retryable: false, breaker: true,
    message: () => "codex 실행 파일을 찾지 못했어요",
    action: () => "npm i -g @openai/codex 후 install.sh 를 다시 실행하세요",
  },
  codex_start: {
    retryable: false, breaker: true,
    message: (d) => `Codex를 시작하지 못했어요: ${d}`,
    action: () => "터미널에서 codex --version 과 codex login status 를 확인하세요",
  },
};

// Codes that only steer the bridge's own recovery; if one ever reaches toFatal
// it is reported as an internal error.
const INTERNAL_ONLY = new Set(["tier_unsupported", "context_full", "params", "unsupported_method"]);

export function message(code, detail = "", extra = {}) {
  const info = INFO[code] || INFO.internal;
  return info.message(String(detail ?? "").slice(0, 200), extra || {});
}

export function toFatal(be, { codexVersion } = {}) {
  let code = be?.code || "internal";
  let detail = be?.detail ?? be?.message ?? "";
  if (INTERNAL_ONLY.has(code) || !INFO[code]) { detail = `${code}${detail ? ` ${detail}` : ""}`; code = "internal"; }
  const extra = be?.extra || {};
  const info = INFO[code];
  let action = info.action(extra);
  if (codexVersion && cmpVersion(codexVersion, TESTED_MIN_CODEX) < 0) {
    action += ` (Codex ${codexVersion}는 테스트되지 않은 오래된 버전이에요: npm i -g @openai/codex@latest)`;
  }
  return { code, message: info.message(String(detail).slice(0, 200), extra), action, retryable: info.retryable };
}

const NET_KEYS = new Set(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"]);
const SERVER_KEYS = new Set(["serverOverloaded", "internalServerError", "responseTooManyFailedAttempts"]);

export function classify(err) {
  if (err instanceof BridgeError) return err;
  const msg = String(err?.message || "");
  const info = err?.codexErrorInfo;
  const key = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  let status = (info && typeof info === "object" ? info[key]?.httpStatusCode : null) ?? null;
  if (status == null) {
    const m = msg.match(/"status"\s*:\s*(\d{3})/) || msg.match(/\b(?:status|HTTP)\s*:?\s*(\d{3})\b/i);
    status = m ? Number(m[1]) : null;
  }
  const rpc = err?.rpcCode;
  const mk = (code, extra = {}) => {
    const be = new BridgeError(code, msg, extra);
    if (err?.usage) be.usage = err.usage;
    be.cause = err;
    return be;
  };
  if (rpc === -32601) return mk("unsupported_method");
  if (key === "unauthorized" || status === 401 || /unauthori[sz]ed|not logged in|log ?in again|refresh token/i.test(msg)) return mk("unauthorized");
  if (key === "usageLimitExceeded" || /usage[ _]limit/i.test(msg)) return mk("usage_limit");
  if (key === "rateLimitExceeded" || status === 429) return mk("rate_limited");
  if (/model[^\n]{0,80}(is not supported|does not exist)|unknown model|model_not_found/i.test(msg)) {
    return mk("model_unsupported", { model: msg.match(/'([^']+)' model/)?.[1] });
  }
  if (/service[_ ]?tier|priority/i.test(msg) && (status === 400 || key === "badRequest" || rpc === -32600)) return mk("tier_unsupported");
  if (key === "contextWindowExceeded") return mk("context_full");
  if (key === "cyberPolicy" || key === "misalignmentPolicyViolation") return mk("policy");
  if (/required MCP servers failed to initialize/i.test(msg)) return mk("mcp", { name: msg.match(/initialize:\s*([^\s:,]+)/)?.[1] });
  if (/failed to load configuration|invalid transport|Invalid configuration/i.test(msg)) return mk("config");
  if (rpc === -32600 && /unknown (variant|field)|invalid type|missing field/i.test(msg)) return mk("params");
  if (NET_KEYS.has(key) || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|stream disconnected|connection (reset|closed|refused)|certificate|TLS/i.test(msg)) return mk("network");
  if (SERVER_KEYS.has(key) || (status != null && status >= 500)) return mk("server");
  if (key === "badRequest" || status === 400) return mk("bad_request");
  return mk("server");
}
