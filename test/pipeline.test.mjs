import "./env.mjs";

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { matches, mergeMeta, processWork } from "../src/pipeline.js";
import * as store from "../src/store.js";
import { makePdf, prose } from "./helpers.mjs";

const TITLE = "Groundwater Recharge in Semi-Arid Basins";
const ROUTES = {
  "/paywall.pdf": ["text/html", Buffer.from("<html><body>Sign in to read</body></html>")],
  "/wrong.pdf": ["application/pdf", makePdf([`Urban Heat Islands and Tree Cover ${prose()}`, prose()])],
  "/scan.pdf": ["application/pdf", makePdf(["", ""])],
  "/right.pdf": ["application/pdf", makePdf([`${TITLE} by Ana Lima ${prose()}`, prose()])],
};

let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    const [type, body] = ROUTES[req.url] ?? ["text/plain", Buffer.from("not found")];
    res.writeHead(ROUTES[req.url] ? 200 : 404, { "Content-Type": type }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A source that answers every query with the given files. */
const fakeSource = (id, meta, paths) => ({
  id,
  name: id,
  missing: () => [],
  find: async () => [{ meta, files: paths.map((p) => ({ url: base + p })) }],
});

const META = { title: TITLE, authors: ["Lima, Ana"], year: 2020, doi: "10.5555/gw.2020" };

test("bad candidates are skipped and the first passing file is kept", async () => {
  const { work } = await store.add("10.5555/gw.2020");
  const sources = [fakeSource("one", META, ["/paywall.pdf", "/wrong.pdf", "/scan.pdf", "/right.pdf"])];
  const done = await processWork(work, sources);

  assert.equal(done.status, "done", JSON.stringify(done.attempts));
  assert.deepEqual(done.attempts.map((a) => a.verdict), ["fail", "fail", "warn", "pass"]);
  assert.equal(done.file.name, "lima-2020-groundwater-recharge-in-semi-arid-basins.pdf");
  assert.ok(existsSync(join(store.workDir(work.id), done.file.name)));
  // The rejected and superseded downloads leave nothing behind.
  const kept = (await import("node:fs")).readdirSync(store.workDir(work.id)).sort();
  assert.deepEqual(kept, [done.file.name, "work.json"]);
});

test("with only a doubtful file the work goes to review", async () => {
  const { work } = await store.add(`${TITLE} (scanned copy)`);
  const done = await processWork(work, [fakeSource("one", META, ["/scan.pdf"])]);
  assert.equal(done.status, "review");
  assert.ok(done.checks.some((c) => c.name === "text-layer" && c.status === "warn"));
});

test("no usable file means failed, with the reason recorded", async () => {
  const { work } = await store.add("10.5555/none");
  const done = await processWork(work, [fakeSource("one", { ...META, doi: "10.5555/none" }, ["/paywall.pdf"])]);
  assert.equal(done.status, "failed");
  assert.match(done.error, /rejected/);
  assert.equal(done.file, null);
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
  const { gather } = await import("../src/pipeline.js");
  const candidates = await gather({ doi: META.doi }, [byDoi, byTitle]);
  assert.deepEqual(candidates.map((c) => c.source), ["meta", "titles"]);
  assert.equal(seen.at(-1).title, TITLE);
});

test("candidates match on shared identifiers or a fitting title", () => {
  assert.ok(matches({ doi: "10.1/a" }, { meta: { doi: "10.1/A" } }));
  assert.ok(!matches({ doi: "10.1/a" }, { meta: { doi: "10.1/b", title: "x" } }));
  const citation = "Lima A (2020) Groundwater recharge in semi-arid basins. J Hydrol 5:1-9";
  assert.ok(matches({ title: citation }, { meta: { title: TITLE } }));
  assert.ok(!matches({ title: citation }, { meta: { title: "Groundwater" } }));
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
  const csv = (await import("node:fs")).readFileSync(join(process.env.LITFETCH_LIBRARY, "index.csv"), "utf8");
  assert.match(csv, /^id,status,issues,title/);
  assert.match(csv, /doi-10.5555-gw.2020,done/);
});
