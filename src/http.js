/**
 * Every request litfetch makes goes through here (the optional Anthropic SDK in
 * checks/llm.js makes its own). Each request gets a browser-like User-Agent,
 * the per-host pace from config, a timeout that starts once the pace allows the
 * request, and retries on 429, 5xx and network errors (honouring Retry-After).
 * Bot checks are recognised and raised as code "CHALLENGE"; they are never solved.
 */

import { config } from "./config.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/128.0 Safari/537.36";
const RETRIES = 3;

export class HttpError extends Error {
  constructor(message, status = 0, code = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Codes of temporary failures. With 429 and 5xx responses they make up the outages. */
const TRANSIENT = new Set(["NETWORK", "TIMEOUT", "CHALLENGE", "NO_CREDITS", "STALLED", "TOO_SLOW", "TOO_LONG", "INCOMPLETE"]);

/** An outage says nothing about whether the work exists, so it does not count as a try. */
export const isOutage = (err) => TRANSIENT.has(err?.code) || err?.status === 429 || err?.status >= 500;

/** Network errors that will not go away by waiting: bad URL, unknown host, broken certificate. */
const PERMANENT = /ENOTFOUND|INVALID_URL|Invalid URL|parse URL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL|UNKNOWN_SCHEME|not implemented/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reserve request start times per host, `paceOf(host)` ms apart. Resolves at
 * the reserved time and returns it. Clock and sleep are injectable for tests.
 */
export function createPacer({ paceOf, now = Date.now, wait = sleep }) {
  const next = new Map();
  return async function pace(host) {
    const t = now();
    const at = Math.max(t, next.get(host) ?? 0);
    next.set(host, at + paceOf(host));
    if (at > t) await wait(at - t);
    return at;
  };
}

const pace = createPacer({ paceOf: config.paceOf });

/** Name of the bot check a response is, or null. */
export function challengeOf(resp) {
  const header = (name) => resp.headers.get(name) || "";
  if (resp.status === 403 && /ddos-guard/i.test(header("server"))) return "DDoS-Guard";
  if (resp.status >= 300 && resp.status < 400 && /[?&]check=1/.test(header("location"))) return "DDoS-Guard";
  if (header("x-amzn-waf-action")) return "AWS WAF";
  if (header("cf-mitigated") === "challenge") return "Cloudflare";
  return null;
}

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
};

function networkError(err, host) {
  const detail = `${err.cause?.code ?? ""} ${err.cause?.message ?? ""} ${err.message}`;
  const permanent = PERMANENT.test(detail);
  return new HttpError(`${err.cause?.code ?? err.message} (${host})`, 0, permanent ? "UNREACHABLE" : "NETWORK");
}

/**
 * One request. `timeoutMs` bounds the wait for response headers; `totalMs`, if
 * given, bounds the whole exchange including the body read by the caller, and
 * the response then carries that signal as `resp.deadline`. Both start after
 * pacing. Error messages name the host, never the URL, because URLs can carry
 * keys and errors end up in work records.
 */
export async function request(url, { headers = {}, timeoutMs = config.timeoutMs, totalMs, signal, ...options } = {}) {
  const host = hostOf(url);
  for (let attempt = 0; ; attempt++) {
    await pace(host);
    const headerTimer = new AbortController();
    const timer = setTimeout(
      () => headerTimer.abort(new HttpError(`no response from ${host} in ${timeoutMs / 1000} s`, 0, "TIMEOUT")),
      timeoutMs
    );
    const deadline = totalMs ? AbortSignal.timeout(totalMs) : null;
    const signals = [headerTimer.signal, deadline, signal].filter(Boolean);
    let resp;
    try {
      resp = await fetch(url, { ...options, headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.any(signals) });
    } catch (err) {
      const aborted = signals.find((s) => s.aborted);
      if (aborted) throw asHttpError(aborted.reason, host);
      const failure = networkError(err, host);
      if (failure.code === "UNREACHABLE" || attempt >= RETRIES) throw failure;
      await sleep(1000 * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }
    const check = challengeOf(resp);
    if (check) {
      await resp.body?.cancel();
      throw new HttpError(`bot check (${check}) at ${host}`, resp.status, "CHALLENGE");
    }
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt >= RETRIES) return Object.assign(resp, { deadline });
    await resp.body?.cancel();
    const after = Number(resp.headers.get("retry-after"));
    await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
  }
}

const asHttpError = (reason, host) =>
  reason instanceof HttpError ? reason : new HttpError(`timed out (${host})`, 0, "TIMEOUT");

/** API calls: the whole exchange, body included, must finish within the timeout. */
async function body(url, options, read) {
  const resp = await request(url, { totalMs: config.timeoutMs, ...options });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(`HTTP ${resp.status} (${hostOf(url)})`, resp.status);
  }
  try {
    return await read(resp);
  } catch (err) {
    if (resp.deadline?.aborted) throw asHttpError(resp.deadline.reason, hostOf(url));
    throw err;
  }
}

/** A client with default headers (e.g. an API key) for one source. */
export function client({ headers = {} } = {}) {
  const merge = (options = {}) => ({ ...options, headers: { ...headers, ...options.headers } });
  return {
    request: (url, options) => request(url, merge(options)),
    json: (url, options) => body(url, merge(options), (r) => r.json()),
    text: (url, options) => body(url, merge(options), (r) => r.text()),
    /** Like json(), but a 404 ("no such record") resolves to null. */
    lookup: async (url, options) => {
      try {
        return await body(url, merge(options), (r) => r.json());
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
  };
}

/**
 * Interchangeable mirrors of one site. `ordered()` lists them starting with the
 * one that last worked; `run(fn)` tries them in that order and moves on when a
 * mirror is down or challenges. Running out of credits is an account matter, so
 * it ends the search instead.
 */
export function mirrorSet(bases) {
  let preferred = bases[0];
  const ordered = () => [preferred, ...bases.filter((b) => b !== preferred)].filter(Boolean);
  return {
    ordered,
    worked: (base) => {
      preferred = base;
    },
    async run(fn) {
      let last = new Error("no mirrors configured");
      for (const base of ordered()) {
        try {
          const result = await fn(base);
          preferred = base;
          return result;
        } catch (err) {
          if (!isOutage(err) || err.code === "NO_CREDITS") throw err;
          last = err;
        }
      }
      throw last;
    },
  };
}
