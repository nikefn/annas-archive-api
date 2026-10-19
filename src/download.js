/**
 * Stream a URL to disk, hashing as it goes. The file lands at `dest` only when
 * the transfer completed. Downloads have their own limits, separate from the
 * API timeout, and every abort says why.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { once } from "node:events";

import { config } from "./config.js";
import { HttpError, request } from "./http.js";

export const LIMITS = {
  connectMs: 30_000, // until response headers
  stallMs: 60_000, // longest gap without data
  minBytesPerSec: 20 * 1024, // average rate, checked once minRateAfterMs has passed
  minRateAfterMs: 120_000,
  totalMs: 20 * 60_000,
};

export async function download(url, dest, { headers, limits = {} } = {}) {
  const lim = { ...LIMITS, maxBytes: config.maxBytes, ...limits };
  const abort = new AbortController();
  const stop = (code, message) => abort.abort(new HttpError(message, 0, code));

  const resp = await request(url, { headers, redirect: "follow", timeoutMs: lim.connectMs, signal: abort.signal });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(`HTTP ${resp.status}`, resp.status);
  }
  const declared = Number(resp.headers.get("content-length")) || null;
  if (declared > lim.maxBytes) {
    await resp.body?.cancel();
    throw new HttpError(`larger than ${lim.maxBytes} bytes`, 0, "TOO_LARGE");
  }

  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  const part = `${dest}.part`;
  const out = createWriteStream(part);
  out.on("error", (err) => abort.abort(new HttpError(`cannot write ${part}: ${err.message}`, 0, "WRITE")));
  const started = Date.now();
  let bytes = 0;
  let stall;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => stop("STALLED", `stalled: no data for ${lim.stallMs / 1000} s`), lim.stallMs);
  };
  const total = setTimeout(() => stop("TOO_LONG", `took longer than ${lim.totalMs / 60_000} min`), lim.totalMs);

  try {
    armStall();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      bytes += value.length;
      if (bytes > lim.maxBytes) stop("TOO_LARGE", `larger than ${lim.maxBytes} bytes`);
      const elapsed = Date.now() - started;
      if (elapsed > lim.minRateAfterMs && (bytes * 1000) / elapsed < lim.minBytesPerSec) {
        stop("TOO_SLOW", `too slow: ${Math.round(((bytes * 1000) / elapsed) / 1024)} KB/s`);
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      md5.update(value);
      sha256.update(value);
      if (!out.write(value)) await once(out, "drain");
    }
    if (declared && bytes !== declared) {
      throw new HttpError(`incomplete: ${bytes} of ${declared} bytes`, 0, "INCOMPLETE");
    }
    out.end();
    await once(out, "finish");
    await rename(part, dest);
  } catch (err) {
    out.destroy();
    await rm(part, { force: true });
    if (abort.signal.aborted && abort.signal.reason?.code !== "WRITE") throw abort.signal.reason;
    if (err instanceof HttpError) throw err;
    throw new HttpError(`incomplete: ${err.message} after ${bytes} bytes`, 0, "INCOMPLETE");
  } finally {
    clearTimeout(stall);
    clearTimeout(total);
  }

  return {
    bytes,
    md5: md5.digest("hex"),
    sha256: sha256.digest("hex"),
    contentType: resp.headers.get("content-type") || "",
  };
}
