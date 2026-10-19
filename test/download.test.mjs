import { scratch } from "./env.mjs";

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";

import { config } from "../src/config.js";
import { LIMITS, download } from "../src/download.js";

const dir = scratch("downloads");
const GZIPPED = gzipSync(Buffer.alloc(200_000, 7));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each route streams `chunks` chunks of `size` bytes, `gap` ms apart, then waits `hang` ms. */
const ROUTES = {
  "/steady": { size: 64 * 1024, chunks: 30, gap: 50 },
  "/stalls": { size: 10 * 1024, chunks: 1, gap: 0, hang: 2000 },
  "/trickle": { size: 1024, chunks: 40, gap: 100 },
  "/short": { size: 1000, chunks: 1, gap: 0, declared: 5000 },
};

let server;
let base;
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/gzip") {
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Encoding": "gzip", "Content-Length": GZIPPED.length });
      res.end(GZIPPED);
      return;
    }
    const r = ROUTES[req.url];
    res.writeHead(200, { "Content-Type": "application/pdf", ...(r.declared ? { "Content-Length": r.declared } : {}) });
    for (let i = 0; i < r.chunks && !res.destroyed; i++) {
      res.write(Buffer.alloc(r.size, 1));
      await sleep(r.gap);
    }
    if (r.hang) await sleep(r.hang);
    if (r.declared || r.hang) res.destroy();
    else res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// The same rules as the defaults, scaled down so the suite stays fast.
const FAST = { connectMs: 300, stallMs: 400, minBytesPerSec: 20 * 1024, minRateAfterMs: 500, totalMs: 10_000 };

test("defaults: 30 s to connect, 60 s stall, 20 KB/s after 2 min, 20 min total, 600 MB", () => {
  assert.deepEqual(LIMITS, { connectMs: 30_000, stallMs: 60_000, minBytesPerSec: 20 * 1024, minRateAfterMs: 120_000, totalMs: 1_200_000 });
  assert.equal(config.maxBytes, 600 * 1024 * 1024);
});

test("a slow but steady download outlives the connect timeout", async () => {
  const dest = join(dir, "steady.pdf");
  const got = await download(`${base}/steady`, dest, { limits: FAST });
  assert.equal(got.bytes, 30 * 64 * 1024);
  assert.equal(statSync(dest).size, got.bytes);
});

test("a server that stops sending fails as stalled", async () => {
  await assert.rejects(download(`${base}/stalls`, join(dir, "stalls.pdf"), { limits: FAST }), { code: "STALLED", message: /stalled/ });
  assert.ok(!existsSync(join(dir, "stalls.pdf")) && !existsSync(join(dir, "stalls.pdf.part")));
});

test("a trickle below the minimum rate fails as too slow", async () => {
  await assert.rejects(download(`${base}/trickle`, join(dir, "trickle.pdf"), { limits: FAST }), { code: "TOO_SLOW", message: /too slow/ });
});

test("a body shorter than its Content-Length fails as incomplete", async () => {
  await assert.rejects(download(`${base}/short`, join(dir, "short.pdf"), { limits: FAST }), { code: "INCOMPLETE" });
});

test("a compressed response is complete even though Content-Length counts compressed bytes", async () => {
  const got = await download(`${base}/gzip`, join(dir, "gzip.pdf"), { limits: FAST });
  assert.equal(got.bytes, 200_000);
});
