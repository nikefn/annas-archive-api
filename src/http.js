/**
 * The only place that talks to the network. Every request gets a browser-like
 * User-Agent, a header timeout, retries on 429/5xx/network errors (honouring
 * Retry-After) and the per-host pace from config. Bot checks are recognised and
 * raised as code "CHALLENGE"; they are never solved.
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

/** Codes of temporary failures; together with 429, 5xx and network errors they are outages. */
const TRANSIENT = new Set(["CHALLENGE", "NO_CREDITS", "TIMEOUT", "STALLED", "TOO_SLOW", "TOO_LONG", "INCOMPLETE"]);

/** An outage says nothing about whether the work exists, so it does not count as a try. */
export const isOutage = (err) =>
  TRANSIENT.has(err?.code) || err?.status === 0 || err?.status === 429 || err?.status >= 500;

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

/**
 * One request. `timeoutMs` bounds the wait for response headers only; pass a
 * `signal` to bound the body. Error messages name the host, never the URL,
 * because URLs can carry keys and errors end up in work records.
 */
export async function request(url, { headers = {}, timeoutMs = config.timeoutMs, signal, ...options } = {}) {
  const host = hostOf(url);
  for (let attempt = 0; ; attempt++) {
    await pace(host);
    const headerTimer = new AbortController();
    const timer = setTimeout(
      () => headerTimer.abort(new HttpError(`no response from ${host} in ${timeoutMs / 1000} s`, 0, "TIMEOUT")),
      timeoutMs
    );
    let resp;
    try {
      resp = await fetch(url, {
        ...options,
        headers: { "User-Agent": USER_AGENT, ...headers },
        signal: signal ? AbortSignal.any([headerTimer.signal, signal]) : headerTimer.signal,
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (signal?.aborted) throw asHttpError(signal.reason, host);
      if (attempt >= RETRIES) throw new HttpError(`${err.message} (${host})`, 0);
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
    if (!retryable || attempt >= RETRIES) return resp;
    await resp.body?.cancel();
    const after = Number(resp.headers.get("retry-after"));
    await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
  }
}

const asHttpError = (reason, host) =>
  reason instanceof HttpError ? reason : new HttpError(`timed out (${host})`, 0, "TIMEOUT");

/** API calls: the whole exchange, body included, must finish within the timeout. */
async function body(url, options, read) {
  const signal = AbortSignal.timeout(config.timeoutMs);
  const resp = await request(url, { signal, ...options });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(`HTTP ${resp.status} (${hostOf(url)})`, resp.status);
  }
  try {
    return await read(resp);
  } catch (err) {
    if (signal.aborted) throw asHttpError(signal.reason, hostOf(url));
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
 * one that last worked; `run(fn)` tries them in that order, moving on only when
 * a mirror has an outage.
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
