import { IExecuteFunctions, NodeApiError, JsonObject } from "n8n-workflow";


// Methods that are SAFE to re-send after the server may have acted: read-only
// by HTTP semantics (RFC 9110 SS9.2.1). Only these are retried on an ambiguous
// failure (a 5xx, ETIMEDOUT, ECONNRESET, socket hang-up).
//
// PUT and DELETE are deliberately ABSENT although RFC 9110 calls them
// idempotent: this service's PUT/DELETE handlers are not audited for it, and a
// re-sent DELETE after the first one landed turns a success into a 404. POST
// and PATCH are absent because a re-send double-applies the write.
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

// Failures that happen BEFORE a single request byte reaches the server: the
// TCP connect was refused, or the name never resolved. Only these are retried
// for a non-idempotent method, because only these PROVE the server did nothing.
//
// ⛔ ETIMEDOUT, ECONNRESET, EPIPE and "socket hang up" are NOT here and must
// never be: each can fire after the request was delivered and while (or after)
// the server committed the write, so a re-send double-applies it.
const PRE_SEND_NET_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

const PRE_SEND_MESSAGE_RE = /\bconnect ECONNREFUSED\b|\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN)\b/;

/** True only when the error proves the request never reached the server. */
export function isPreSendNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
  // A code, when present, is authoritative: an ETIMEDOUT whose message happens
  // to mention a refused connect is still an ETIMEDOUT.
  const code = typeof e.code === "string" ? e.code : undefined;
  const causeCode = e.cause && typeof e.cause.code === "string" ? e.cause.code : undefined;
  if (code !== undefined || causeCode !== undefined) {
    return (
      (code === undefined || PRE_SEND_NET_CODES.has(code)) &&
      (causeCode === undefined || PRE_SEND_NET_CODES.has(causeCode))
    );
  }
  return typeof e.message === "string" && PRE_SEND_MESSAGE_RE.test(e.message);
}

export function isIdempotentMethod(method?: string): boolean {
  if (typeof method !== "string" || method.length === 0) return false;
  return IDEMPOTENT_METHODS.has(method.trim().toUpperCase());
}

// Connection-layer errors that warrant a retry rather than an immediate
// fail-out. Without this, a fast TCP reset surfaces as `read ECONNRESET` from
// n8n's httpRequest, no statusCode, falls past the 5xx branch, and
// gets thrown after the very first attempt.
const TRANSIENT_NET_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

const TRANSIENT_NET_MESSAGE_RE = /socket hang up|connection (?:reset|aborted)/i;

export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string" && TRANSIENT_NET_CODES.has(e.code)) return true;
  if (e.cause && typeof e.cause.code === "string" && TRANSIENT_NET_CODES.has(e.cause.code)) return true;
  if (typeof e.message === "string" && TRANSIENT_NET_MESSAGE_RE.test(e.message)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Keep the service's own words.
//
// Every branch below used to pass a FIXED per-status "message:" to NodeApiError,
// which discards the upstream body entirely. n8n serialises only ".message" into
// a "continueOnFail" item ({json:{error: error.message}}) and onto the canvas
// badge, so the operator saw a constant where the diagnosis should have been.
//
// Measured cost: a service's 400 read as a generic invalid-token message when
// the service had said "must be a UUID", and an upstream 422 read as
// "Validation error" when the service had said "Must not have boards" —
// which hid a six-month data leak.
// ---------------------------------------------------------------------------

// A 4xx body can echo what we SENT. Measured reachable leaks: some services echo
// a bearer token placed in X-Tenant-Id back in a 400 body, and FastAPI/pydantic-v2
// with no RequestValidationError handler registered echoes the offending value in
// detail[].input.
//
// An earlier revision used "length >= 40 and contains no whitespace" as the
// credential test. Measured, that was wrong in BOTH directions: it redacted
// exception names, URLs, file paths and tenant_id=<uuid> (4/4 false positives —
// i.e. it re-created the very constant-message defect this change exists to
// remove), while a DSN password, a bearer token and a JWT embedded in a SENTENCE
// all passed through verbatim (3/4 false negatives). Shape-of-the-VALUE beats
// shape-of-the-string.
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[-_]?key|credential|cookie/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-fA-F]+$/;

// An adversarial review fed LIVE token shapes through this and measured six that
// walked straight out, all of them in NON-BARE positions (i.e. with surrounding
// text), which the whole-string opaque rule below could never see:
//   glsa_..._a1b2c3d4  <- a Grafana service-account token: THE case this fix exists for
//   eyJrIjoi...MX0=    <- a Grafana LEGACY api key; the trailing "=" defeats the run rule
//   Basic <base64>     <- an HTTP Basic credential
//   AKIA... + secret   <- AWS
//   a bearer token inside a sentence
const CREDENTIAL_PATTERNS: RegExp[] = [
  // JWT first: it must consume a dotted token before the bare-base64 rule below
  // gets to nibble its header segment.
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,
  // A base64 run starting "eyJ" is base64-encoded JSON, i.e. `{"...`. Grafana's
  // legacy API key is exactly this ({"k":..,"n":..,"id":1}) and its "=" padding
  // is why the opaque-run rule never fired on it.
  /eyJ[A-Za-z0-9+/_-]{16,}={0,2}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /sk-[A-Za-z0-9]{16,}/g,
  /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
  // Grafana tokens: glsa_ (service account), glc_ (cloud access policy), glapi_.
  /\bgl[a-z]{1,4}_[A-Za-z0-9]{8,}(?:_[A-Za-z0-9]{4,})?/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // An AWS secret access key is exactly 40 chars of the base64 alphabet, and it
  // carries "/" often enough that the opaque-run rule (which stops at "/") sees
  // only three short fragments. The lookahead exempts a 40-char hex SHA-1, which
  // is a legitimate identifier an operator needs to read.
  /\b(?![0-9a-fA-F]{40}\b)[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/g,
];

// "Basic <base64>" needs a guard, not a plain pattern: the prose "Basic
// authentication failed" matches the same shape. A real base64 of "user:pass"
// always carries a non-letter; an English word never does.
const BASIC_AUTH_RE = /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g;

// Whether ONE opaque run (no . : / = or whitespace) is a credential rather than
// an identifier. Run on SUBSTRINGS, because every measured leak was embedded in
// a sentence and the old whole-string test therefore never fired.
//
// The false-positive side is the expensive one: eating an identifier re-creates
// the constant-message defect this whole change exists to remove. So a run is
// only a credential when it is BOTH long and mixed-alphabet:
//   - a UUID or a pure-hex run (SHA-1/SHA-256/commit/md5) is an identifier;
//   - a run with no case mixture is a word, a snake_case prometheus metric name
//     (`node_network_receive_bytes_total`) or an exception name;
//   - 24 chars is low enough to catch the 29-char Grafana token the review
//     measured leaking, and high enough to leave `attachment-9f3a2b7c8d4e` (23)
//     and `ConstraintValidationFailed` (26, no digit) alone.
// Measured false positive that forced this: `Prometheus-Production-EU-West-1`
// — an entirely plausible Grafana datasource name — is 31 chars with mixed case
// and a digit, i.e. indistinguishable from a token by length and alphabet alone.
// A run whose every `-`/`_` segment is a WORD (a lowercase or Capitalised word,
// a CamelCase compound, a short acronym, or any of those with a small version
// suffix) is a name, not a credential. A token fails this because its case and
// digits change INSIDE a segment: `RuxcGsgE8A6k9FzJme9bMb4D` is not a word, and
// `QWERTYUIOPASDFGH` is too long to be an acronym.
const WORDLIKE_SEGMENT_RE = /^(?:[A-Z]?[a-z]+(?:[A-Z][a-z]+)*[0-9]{0,4}|[A-Z]{1,8}[0-9]{0,4}|[0-9]{1,8})$/;

function isWordLike(run: string): boolean {
  return run.split(/[-_]/).every(function (seg) {
    return seg.length > 0 && WORDLIKE_SEGMENT_RE.test(seg);
  });
}

function isOpaqueCredentialRun(run: string): boolean {
  if (UUID_RE.test(run)) return false;
  if (HEX_RE.test(run)) return false;
  if (run.length >= 64) return true;
  const hasUpper = /[A-Z]/.test(run);
  const hasLower = /[a-z]/.test(run);
  if (!hasUpper || !hasLower) return false;
  if (isWordLike(run)) return false;
  if (run.length >= 32) return true;
  return /[0-9]/.test(run) && run.length >= 24;
}

const OPAQUE_RUN_RE = /[A-Za-z0-9_-]{20,}/g;

function scrubString(s: string): string {
  let out = s;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, "<redacted>");
  out = out.replace(BASIC_AUTH_RE, function (whole) {
    const token = whole.replace(/^Basic\s+/i, "");
    return /^[A-Za-z]+$/.test(token) ? whole : "<redacted>";
  });
  out = out.replace(OPAQUE_RUN_RE, function (run) {
    return isOpaqueCredentialRun(run) ? "<redacted>" : run;
  });
  return out;
}

function redactSecrets(value: unknown, depth: number): unknown {
  if (depth > 4) return "<depth>";
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(function (v) { return redactSecrets(v, depth + 1); });
  if (value && typeof value === "object") {
    // FastAPI validation errors carry {loc:[...], input:<what we sent>}. Redact
    // "input" only when its own "loc" names a sensitive field — blanket-redacting
    // "input" would destroy ordinary validation diagnostics.
    let locIsSensitive = false;
    try {
      const loc = (value as Record<string, unknown>).loc;
      if (Array.isArray(loc)) locIsSensitive = loc.some(function (p: unknown) { return typeof p === "string" && SENSITIVE_KEY.test(p); });
    } catch { locIsSensitive = false; }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).slice(0, 40)) {
      if (SENSITIVE_KEY.test(k) || (k === "input" && locIsSensitive)) out[k] = "<redacted>";
      else out[k] = redactSecrets((value as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return value;
}

export function upstreamDetail(error: unknown): string | undefined {
  // TOTAL try/catch is load-bearing. This runs INSIDE an error handler, so
  // anything thrown here replaces a clean, typed failure (a 403 the caller can
  // act on) with an unhandled crash. Measured throwing inputs before the guard:
  // a circular body, a Symbol detail, and a body accessor that throws on read.
  try {
    // `error` is genuinely unknown here — it is whatever the HTTP layer threw —
    // so it is narrowed locally rather than typed `any`, which would switch off
    // checking for the whole function.
    const e = error as
      | { response?: { body?: unknown; data?: unknown }; body?: unknown; error?: unknown }
      | null
      | undefined;
    // ORDER MATTERS, AND `.error` IS THE ONE THAT ACTUALLY FIRES IN PRODUCTION.
    //
    // `ctx.helpers.request` resolves to n8n-core's proxyRequestToAxios, which on
    // a non-2xx throws:
    //   error.message = `${status} - ${JSON.stringify(responseData)}`;
    //   Object.assign(error, { statusCode, status,
    //                          error: responseData,
    //                          response: pick(response, ['headers','status','statusText']) })
    // The parsed body lands on `.error`, and `.response` is PICKED DOWN to three
    // keys - no body, no data. Reading only `.response.body`/`.response.data`
    // found nothing against live n8n 2.x, so the previous revision of this fix
    // was INERT in production while its tests passed against a shape n8n never
    // emits. `.error` goes LAST so an explicit body still wins where one exists.
    let body: unknown = e?.response?.body ?? e?.response?.data ?? e?.body ?? e?.error;
    // `.error` is not always a body. For a non-HTTP failure (DNS, TLS, socket)
    // it can be the Error object itself, and JSON.stringify(new Error('x')) is
    // '{}' - which would ERASE the diagnosis instead of surfacing it. Unwrap it.
    if (body instanceof Error) body = { message: body.message };
    if (typeof body === "string") {
      const s = body.trim();
      if (!s) return undefined;
      try {
        body = JSON.parse(s);
      } catch {
        // Non-JSON bodies are scrubbed too — this branch used to return raw.
        return scrubString(s).slice(0, 500);
      }
    }
    const b = body as Record<string, unknown> | null | undefined;
    const raw =
      b?.detail ??
      b?.message ??
      b?.error_description ??
      b?.error ??
      undefined;
    if (raw === undefined || raw === null) return undefined;
    // JSON.stringify returns undefined for a Symbol/function, so the result is
    // re-checked as a string rather than assumed to be one.
    const text = typeof raw === "string" ? scrubString(raw.trim()) : JSON.stringify(redactSecrets(raw, 0));
    if (typeof text !== "string" || text.length === 0) return undefined;
    return text.slice(0, 500);
  } catch {
    return undefined;
  }
}

export function withDetail(hint: string, error: unknown): string {
  try {
    const detail = upstreamDetail(error);
    if (!detail) return hint;
    if (detail === hint) return hint;
    if (detail.includes(hint)) return detail;
    return hint + ": " + detail;
  } catch {
    return hint;
  }
}

// ---------------------------------------------------------------------------
// n8n DESTROYS a message that mentions a libuv error code.
//
// NodeError.setDescriptiveErrorMessage (n8n-workflow/dist/*/errors/abstract/
// node.error.js) walks COMMON_ERRORS and, if the message CONTAINS any code as a
// case-insensitive SUBSTRING, replaces the WHOLE message with a canned string.
// Measured against n8n-workflow 1.120.x:
//   "...returned EACCES from Loki"  -> "Forbidden by access permissions, make
//                                       sure you have the right permissions"
//   "upstream ETIMEDOUT while..."   -> "The connection timed out, consider
//                                       setting the 'Retry on Fail' option..."
// Both the hint AND the service's own words are gone. This was IMPOSSIBLE before
// this change, because the fixed per-status hints contained no such substring —
// making `message` carry the upstream body is exactly what exposes it.
//
// So: if the composed message would trip the rewrite, keep the plain hint as the
// message (which n8n leaves alone) and carry the upstream words on `description`
// instead, which setDescriptiveErrorMessage never touches. The information
// survives either way.
// ---------------------------------------------------------------------------
const N8N_COMMON_ERROR_CODES: readonly string[] = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERRADDRINUSE",
  "EADDRNOTAVAIL",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENOENT",
  "EISDIR",
  "ENOTDIR",
  "EACCES",
  "EEXIST",
  "EPERM",
  "GETADDRINFO",
];

export function triggersN8nMessageRewrite(message: string): boolean {
  if (typeof message !== "string") return false;
  const upper = message.toUpperCase();
  return N8N_COMMON_ERROR_CODES.some(function (code) { return upper.includes(code); });
}

export function apiErrorOptions(
  hint: string,
  description: string,
  error: unknown,
): { message: string; description: string } {
  try {
    const message = withDetail(hint, error);
    if (message !== hint && triggersN8nMessageRewrite(message)) {
      const detail = upstreamDetail(error);
      return {
        message: hint,
        description: detail ? detail + " — " + description : description,
      };
    }
    return { message, description };
  } catch {
    return { message: hint, description };
  }
}

export class RetryingRequest {
  private readonly MAX_RETRIES = 3;
  // Last delay is 8s (was 4s) to outlive a typical 5–10s network reset
  // window without inflating the cap below the n8n node's default
  // execution timeout.
  private readonly RETRY_DELAYS = [1000, 2000, 8000];

  async executeWithRetry<T>(
    requestFn: () => Promise<T>,
    context: IExecuteFunctions,
    options?: { method?: string },
  ): Promise<T> {
    let lastError: Error;
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        return await requestFn();
      } catch (error: unknown) {
        lastError = error as Error;
        // NodeApiError's 2nd parameter is typed JsonObject, so the caught value is
        // narrowed once here and reused, rather than left `any` (which switched off
        // checking for this whole method — and is how nine untyped values reached a
        // security-adjacent file unnoticed, since `npm run lint` did not cover
        // helpers/ at all until this commit).
        const err = error as JsonObject & { statusCode?: number; response?: { status?: number } };
        const statusCode = err?.statusCode || err?.response?.status;
        if (statusCode === 401) {
          throw new NodeApiError(context.getNode(), err, apiErrorOptions(
            "Authentication failed",
            "Check the API token and the backend URL in credential settings.",
            error,
          ));
        }
        if (statusCode === 403) {
          throw new NodeApiError(context.getNode(), err, apiErrorOptions(
            "Access denied",
            "These credentials do not permit this operation.",
            error,
          ));
        }
        if (statusCode === 429) {
          throw new NodeApiError(context.getNode(), err, apiErrorOptions(
            "Rate limit exceeded",
            "Wait before retrying.",
            error,
          ));
        }
        // An HTTP status means the server RESPONDED, so the request was delivered
        // and processed to some degree; ETIMEDOUT, ECONNRESET and socket hang-up
        // can likewise fire after delivery. For a NON-idempotent method a re-send
        // double-applies the write, so it retries ONLY on a pre-send failure
        // (ECONNREFUSED, DNS), which proves the server never saw the request.
        // An absent or unrecognised method fails SAFE: treated as non-idempotent.
        const retryable = isIdempotentMethod(options?.method)
          ? (typeof statusCode === "number" && statusCode >= 500) ||
            isTransientNetworkError(error) ||
            isPreSendNetworkError(error)
          : isPreSendNetworkError(error);
        if (retryable && attempt < this.MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, this.RETRY_DELAYS[attempt]));
          continue;
        }
        throw error;
      }
    }
    throw lastError!;
  }
}
