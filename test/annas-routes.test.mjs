/**
 * The Anna's Archive adapter against a local stand-in for the site: credits,
 * the per-work cap and the free routes (IPFS gateways, SciDB).
 */

import "./env.mjs";

import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { makePdf, prose } from "./helpers.mjs";

const md5 = (b) => createHash("md5").update(b).digest("hex");
const files = new Map(); // md5 -> pdf bytes
const book = (title) => {
  const pdf = makePdf([`${title} ${prose()}`, prose()]);
  files.set(md5(pdf), pdf);
  return md5(pdf);
};

const site = { credits: 3, fastCalls: [], recordCalls: [], ipfs: new Map(), search: [] };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, body, type = "application/json") =>
    res.writeHead(status, { "Content-Type": type }).end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  if (url.pathname === "/account/") {
    res.writeHead(200, { "Set-Cookie": "aa_account_id2=session; Path=/" }).end("ok");
  } else if (url.pathname.startsWith("/db/aarecord_elasticsearch/md5:")) {
    const id = url.pathname.slice(31, 63);
    site.recordCalls.push(id);
    const cid = site.ipfs.get(id);
    send(200, { file_unified_data: { extension_best: "pdf", filesize_best: 5e6, ipfs_infos: cid ? [{ ipfs_cid: cid }] : [] } });
  } else if (url.pathname === "/dyn/api/fast_download.json") {
    const id = url.searchParams.get("md5");
    site.fastCalls.push(id);
    if (site.credits <= 0) return send(429, { download_url: null, error: "No downloads left" });
    site.credits--;
    send(200, { download_url: `${base}/files/${id}.pdf`, account_fast_download_info: { downloads_left: site.credits } });
  } else if (url.pathname.startsWith("/files/") || url.pathname.startsWith("/gw/ipfs/")) {
    const id = url.pathname.split("/").pop().replace(".pdf", "");
    const bytes = files.get(id) ?? files.get([...site.ipfs].find(([, cid]) => cid === id)?.[0]);
    bytes ? send(200, bytes, "application/pdf") : send(404, "not found", "text/plain");
  } else if (url.pathname === "/search" && url.searchParams.get("q") !== "hop") {
    send(200, site.search.map((m) => `<div class="flex pt-3"><a href="/md5/${m}" class="js-vim-focus">Wanted Book</a></div>`).join(""), "text/html");
  } else if (url.pathname === "/search" && url.searchParams.get("q") === "hop") {
    site.cookieSeen = req.headers.cookie ?? null;
    res.writeHead(302, { Location: `http://localhost:${server.address().port}/landed` }).end();
  } else if (url.pathname === "/landed") {
    site.cookieAfterHop = req.headers.cookie ?? null;
    send(200, "<p>moved</p>", "text/html");
  } else if (url.pathname.startsWith("/scidb/")) {
    send(200, `<iframe src="/pdfjs/web/viewer.html?file=${encodeURIComponent(`${base}/files/${site.scidb}.pdf`)}"></iframe>`, "text/html");
  } else {
    send(404, "not found", "text/plain");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ANNAS_MIRRORS = base;
process.env.ANNAS_KEY = "member-key-for-tests";
process.env.IPFS_GATEWAYS = `${base}/gw`;

const assert = (await import("node:assert/strict")).default;
const { after, test } = await import("node:test");
const { readState, writeState, add } = await import("../src/store.js");
const { newRunState, processWork } = await import("../src/pipeline.js");
const annasModule = await import("../src/sources/annas.js");
const annas = annasModule.default;

after(() => server.close());

test("credits: when the quota runs out, the next work waits for the refill without a request", async () => {
  const shared = newRunState();
  const ids = ["A", "B", "C", "D"].map((t) => book(`Credit Test ${t}`));
  const done = [];
  for (const id of ids) {
    const { work } = await add(`md5:${id}`);
    done.push(await processWork(work, [annas], { shared }));
  }
  assert.deepEqual(done.map((w) => Boolean(w.file)), [true, true, true, false]);
  assert.deepEqual(site.fastCalls, ids.slice(0, 3));
  assert.ok(!site.recordCalls.includes(ids[3]), "no record is read while there are no credits");
  const state = await readState("annas");
  assert.equal(state.left, 0);
  assert.equal(done[3].status, "waiting");
  assert.equal(done[3].tries, 0);
  assert.equal(done[3].nextTry, state.refillAt);
  assert.ok(done.slice(0, 3).every((w) => w.file.credit && w.file.url === null), "no download URL is stored");
});

test("at most two credited links per work and run", async () => {
  await writeState("annas", { left: 50, refillAt: null });
  site.credits = 50;
  site.fastCalls = [];
  site.search = ["X", "Y", "Z"].map((t) => book(`Unrelated Pamphlet ${t}`));
  const { work } = await add("Wanted Book");
  const done = await processWork(work, [annas], { shared: newRunState() });
  assert.equal(site.fastCalls.length, 2);
  assert.equal(done.status, "not_found");
});

test("free IPFS routes come before a credit", async () => {
  site.fastCalls = [];
  const id = book("Gateway Book");
  site.ipfs.set(id, "bafygatewaybook");
  const { work } = await add(`md5:${id}`);
  const done = await processWork(work, [annas], { shared: newRunState() });
  assert.ok(done.file);
  assert.equal(site.fastCalls.length, 0);
  assert.equal(done.file.credit, undefined);
});

test("SciDB serves a DOI's PDF without a credit", async () => {
  site.fastCalls = [];
  site.search = [];
  site.scidb = book("Nanometre Scale Thermometry");
  const { work } = await add("10.1038/nature12373");
  const done = await processWork(work, [annas], { shared: newRunState() });
  assert.ok(done.file, JSON.stringify(done.attempts));
  assert.equal(site.fastCalls.length, 0);
});

test("the session cookie is not sent past a redirect to another origin", async () => {
  await annasModule.search("hop", { key: "member-key-for-tests", baseUrl: base, includeDownloads: false });
  assert.equal(site.cookieSeen, "aa_account_id2=session");
  assert.equal(site.cookieAfterHop, null);
});
