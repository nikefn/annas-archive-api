/**
 * The only place that talks to the network. Every request gets a browser-like
 * User-Agent, a timeout, retries on 429/5xx/network errors (honouring
 * Retry-After), and per-client request spacing so each source stays within its
 * published rate limit.
 */

import { config } from "./config.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/128.0 Safari/537.36";
const RETRIES = 3;

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make a client that spaces its requests at least `minIntervalMs` apart.
 * Each source creates one, so limits are per source, not global.
 */
export function client({ minIntervalMs = 0, headers = {} } = {}) {
  let next = 0;

  async function throttle() {
    const wait = next - Date.now();
    next = Math.max(Date.now(), next) + minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  async function request(url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      let resp;
      try {
        resp = await fetch(url, {
          ...options,
          headers: { "User-Agent": USER_AGENT, ...headers, ...options.headers },
          signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs),
        });
      } catch (err) {
        // Host only: full URLs can carry keys, and errors end up in work records.
        if (attempt >= RETRIES) throw new HttpError(`${err.message} (${hostOf(url)})`, 0);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt >= RETRIES) return resp;
      const after = Number(resp.headers.get("retry-after"));
      await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
    }
  }

  async function ok(url, options) {
    const resp = await request(url, options);
    if (!resp.ok) throw new HttpError(`HTTP ${resp.status} (${hostOf(url)})`, resp.status);
    return resp;
  }

  return {
    request,
    json: async (url, options) => (await ok(url, options)).json(),
    text: async (url, options) => (await ok(url, options)).text(),
    /** Like json(), but a 404 ("no such record") resolves to null. */
    lookup: async (url, options) => {
      try {
        return await (await ok(url, options)).json();
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
