import "./env.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError, challengeOf, createPacer, isOutage, mirrorSet } from "../src/http.js";

test("requests to one host are spaced by its pace, other hosts are not held up", async () => {
  const pace = createPacer({ paceOf: (h) => (h === "slow.example" ? 2000 : 0), now: () => 0, wait: async () => {} });
  const starts = await Promise.all(Array.from({ length: 10 }, () => pace("slow.example")));
  assert.deepEqual(starts, [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000]);
  assert.equal(await pace("fast.example"), 0);
});

const resp = (status, headers = {}) => ({ status, headers: new Headers(headers) });

test("bot checks are recognised, ordinary refusals are not", () => {
  assert.equal(challengeOf(resp(403, { server: "ddos-guard" })), "DDoS-Guard");
  assert.equal(challengeOf(resp(302, { location: "/search?q=x&check=1" })), "DDoS-Guard");
  assert.equal(challengeOf(resp(202, { "x-amzn-waf-action": "challenge" })), "AWS WAF");
  assert.equal(challengeOf(resp(403, { "cf-mitigated": "challenge" })), "Cloudflare");
  assert.equal(challengeOf(resp(403)), null);
});

test("outages are temporary failures", () => {
  for (const err of [new HttpError("x", 503), new HttpError("x", 429), new HttpError("x", 0), new HttpError("x", 403, "CHALLENGE")]) {
    assert.ok(isOutage(err), err.status);
  }
  assert.ok(!isOutage(new HttpError("x", 404)));
  assert.ok(!isOutage(new Error("parse error")));
});

test("mirrors: the one that worked last goes first; only outages move on", async () => {
  const m = mirrorSet(["a", "b", "c"]);
  const seen = [];
  const result = await m.run(async (base) => {
    seen.push(base);
    if (base === "a") throw new HttpError("down", 503);
    return base;
  });
  assert.equal(result, "b");
  assert.deepEqual(m.ordered(), ["b", "a", "c"]);
  await assert.rejects(m.run(async () => { throw new HttpError("gone", 404); }), { status: 404 });
});
