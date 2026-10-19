import "./env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { HttpError } from "../src/http.js";
import { gather, isDue, matches, mergeMeta, newPass, processWork } from "../src/pipeline.js";
import * as store from "../src/store.js";
import { makePdf, prose } from "./helpers.mjs";

const TITLE = "Groundwater Recharge in Semi-Arid Basins";
const RIGHT = makePdf([`${TITLE} by Ana Lima ${prose()}`, prose()]);
const WRONG = makePdf([`Urban Heat Islands and Tree Cover ${prose()}`, prose()]);
const md5 = (b) => createHash("md5").update(b).digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const ROUTES = {
  "/paywall.pdf": ["text/html", Buffer.from("<html><body>Sign in to read</body></html>")],
  "/wrong.pdf": ["application/pdf", WRONG],
  "/scan.pdf": ["application/pdf", makePdf(["", ""])],
  "/right.pdf": ["application/pdf", RIGHT],
  "/cut.pdf": ["application/pdf", RIGHT.subarray(0, RIGHT.length - 200)],
};
const hits = {};

let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const [type, body] = ROUTES[path] ?? ["text/plain", Buffer.from("not found")];
    res.writeHead(ROUTES[path] ? 200 : 404, { "Content-Type": type }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const META = { title: TITLE, authors: ["Lima, Ana"], year: 2020, doi: "10.5555/gw.2020" };

/** A source that answers every query with `meta` and the given files (paths or file objects). */
const fakeSource = (id, meta, files, extra = {}) => ({
  id,
  name: id,
  missing: () => [],
  find: async () => [{ meta, files: files.map((f) => (typeof f === "string" ? { url: base + f } : f)) }],
  ...extra,
});

const withDoi = (doi) => ({ ...META, doi });

test("bad candidates are skipped and the first passing file is kept", async () => {
  const { work } = await store.add("10.5555/gw.2020");
  const done = await processWork(work, [fakeSource("one", META, ["/paywall.pdf", "/wrong.pdf", "/scan.pdf", "/right.pdf"])]);
  assert.equal(done.status, "done", JSON.stringify(done.attempts));
  assert.deepEqual(done.attempts.map((a) => a.verdict), ["fail", "fail", "warn", "pass"]);
  assert.equal(done.file.name, "lima-2020-groundwater-recharge-in-semi-arid-basins.pdf");
  // Rejected and superseded downloads leave nothing behind.
  assert.deepEqual(readdirSync(store.workDir(work.id)).sort(), [done.file.name, "work.json"]);
});

test("keeps the file when a re-run finds nothing", async () => {
  const { work } = await store.add("10.5555/keep");
  const first = await processWork(work, [fakeSource("one", withDoi("10.5555/keep"), ["/scan.pdf"])]);
  assert.equal(first.status, "review");
  const path = store.filePath(first);
  const before = sha256(readFileSync(path));
  const again = await processWork(first, [fakeSource("one", withDoi("10.5555/keep"), ["/paywall.pdf"])]);
  assert.equal(again.status, "review");
  assert.equal(sha256(readFileSync(path)), before);
  assert.equal(again.attempts.length, 2);
});

test("a strictly better file replaces the kept one, which moves to _replaced", async () => {
  const { work } = await store.add("10.5555/better");
  const first = await processWork(work, [fakeSource("one", withDoi("10.5555/better"), ["/scan.pdf"])]);
  const done = await processWork(first, [fakeSource("one", withDoi("10.5555/better"), ["/right.pdf"])]);
  assert.equal(done.status, "done");
  const replaced = join(process.env.LITFETCH_LIBRARY, "_replaced", work.id);
  assert.equal(readdirSync(replaced).length, 1);
});

test("a work no source has is not_found, tried again after a day", async () => {
  const { work } = await store.add("10.5555/none");
  const done = await processWork(work, [fakeSource("one", withDoi("10.5555/none"), ["/paywall.pdf"])]);
  assert.equal(done.status, "not_found");
  assert.equal(done.tries, 1);
  const wait = Date.parse(done.nextTry) - Date.now();
  assert.ok(wait > 23 * 3_600_000 && wait <= 24 * 3_600_000, done.nextTry);
  assert.equal(done.file, null);
  assert.match(done.error, /no acceptable file/);
});

test("an outage is not a try and is retried within hours", async () => {
  const { work } = await store.add("10.5555/outage");
  const down = { id: "down", name: "down", missing: () => [], find: async () => { throw new HttpError("HTTP 503", 503); } };
  const done = await processWork(work, [down]);
  assert.equal(done.status, "waiting");
  assert.equal(done.tries, 0);
  assert.ok(Date.parse(done.nextTry) <= Date.now() + 6 * 3_600_000);
  assert.ok(!isDue(done));
  assert.ok(isDue(done, Date.parse(done.nextTry)));
});

test("a bot check pauses the source for the rest of the pass", async () => {
  let calls = 0;
  const walled = {
    id: "walled",
    name: "walled",
    missing: () => [],
    find: async () => {
      calls++;
      throw new HttpError("bot check", 403, "CHALLENGE");
    },
  };
  const pass = newPass();
  for (const doi of ["10.5555/w1", "10.5555/w2"]) {
    const { work } = await store.add(doi);
    assert.equal((await processWork(work, [walled], { pass })).status, "waiting");
  }
  assert.equal(calls, 1);
});

test("a file rejected as listed is not fetched again; a broken download is", async () => {
  let n = 0;
  const signed = () => ({ url: `${base}/wrong.pdf?sig=${n++}`, md5: md5(WRONG) });
  const cut = { url: `${base}/cut.pdf`, md5: md5(RIGHT) };
  const source = { id: "fresh-links", name: "x", missing: () => [], find: async () => [{ meta: withDoi("10.5555/rej"), files: [signed(), cut] }] };
  const { work } = await store.add("10.5555/rej");
  hits["/wrong.pdf"] = hits["/cut.pdf"] = 0;

  const first = await processWork(work, [source]);
  assert.deepEqual(first.rejectedMd5s, [md5(WRONG)]);
  const second = await processWork(first, [source]);
  assert.equal(hits["/wrong.pdf"], 1);
  assert.equal(hits["/cut.pdf"], 2);
  assert.equal(second.status, "not_found");
});

test("for a book, excerpts come last and journal-article files get no credited link", async () => {
  const files = [
    { md5: "a".repeat(32), name: "scimag/10.1/x.pdf", size: 9e6, credit: true },
    { md5: "b".repeat(32), size: 300_000, format: "pdf", credit: true },
    { md5: "c".repeat(32), size: 9e6, format: "pdf", credit: true },
    { md5: "d".repeat(32), size: 12e6, format: "epub", credit: true },
  ];
  const seen = [];
  const shop = fakeSource("shop", { title: TITLE, isbn: ["9780306406157"] }, files, {
    describe: async (f) => files.find((x) => x.md5 === f.md5),
    async *links(file, { allowCredit }) {
      seen.push([file.md5[0], allowCredit]);
      yield { url: `${base}/missing.pdf`, md5: file.md5 };
    },
  });
  const { work } = await store.add("isbn:9780306406157", { type: "book" });
  await processWork(work, [shop]);
  assert.deepEqual(seen, [["c", true], ["d", true], ["b", true], ["a", false]]);
});

test("a DOI-only work is searched again by the title another source found", async () => {
  const seen = [];
  const byDoi = { id: "meta", find: async (q) => (q.doi ? [{ meta: META, files: [] }] : []) };
  const byTitle = {
    id: "titles",
    find: async (q) => {
      seen.push(q);
      return q.title ? [{ meta: { title: TITLE }, files: [] }] : [];
    },
  };
  const candidates = await gather({ doi: META.doi }, [byDoi, byTitle]);
  assert.deepEqual(candidates.map((c) => c.source), ["meta", "titles"]);
  assert.equal(seen.at(-1).title, TITLE);
});

test("candidates match on identifiers or title, and other volumes never match", () => {
  assert.equal(matches({ doi: "10.1/a" }, { meta: { doi: "10.1/A" } }), "same");
  assert.equal(matches({ doi: "10.1/a" }, { meta: { doi: "10.1/b", title: "x" } }), null);
  const citation = "Lima A (2020) Groundwater recharge in semi-arid basins. J Hydrol 5:1-9";
  assert.equal(matches({ title: citation }, { meta: { title: TITLE } }), "same");
  assert.equal(matches({ title: citation }, { meta: { title: "Groundwater" } }), null);
  assert.equal(matches({ title: "The History of Sexuality, Vol. 1" }, { meta: { title: "The History of Sexuality, Vol. 2" } }), null);
  // An identifier whose record fits neither title nor author is not trusted.
  const q = { isbn: "9780306406157", title: TITLE, authors: ["Lima, Ana"] };
  assert.equal(matches(q, { meta: { isbn: ["9780306406157"], title: "Cooking for Two", authors: ["Roe, Ben"] } }), null);
});

test("metadata merges in source order and keeps typed identifiers", () => {
  const meta = mergeMeta({ doi: "10.1/x" }, [
    { source: "a", meta: { title: "First", year: 2020, authors: [] } },
    { source: "b", meta: { title: "Second", authors: ["B, C"], doi: "10.1/y", retracted: true } },
  ]);
  assert.deepEqual(meta, { title: "First", year: 2020, authors: ["B, C"], doi: "10.1/x", retracted: true });
});

test("the index lists every work", async () => {
  await store.writeIndex();
  const csv = readFileSync(join(process.env.LITFETCH_LIBRARY, "index.csv"), "utf8");
  assert.match(csv, /^id,status,issues,kind,title/);
  assert.match(csv, /doi-10.5555-gw.2020,done/);
  assert.ok(existsSync(join(process.env.LITFETCH_LIBRARY, "index.csv")));
});
