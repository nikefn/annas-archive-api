import "./env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkFile } from "../src/checks/index.js";
import { detectFormat } from "../src/checks/file.js";
import { makeEpub, makePdf, prose } from "./helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "litfetch-checks-"));
const META = { title: "Glacier Retreat in the Alps", authors: ["Muster, Erika"], year: 2021, pages: 2 };

async function check(name, bytes, { meta = META, expected = {}, candidates } = {}) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const file = {
    md5: createHash("md5").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const result = await checkFile({
    path,
    file,
    expected,
    meta,
    candidates: candidates ?? [{ source: "crossref", meta }],
    duplicates: new Map(),
  });
  result.byName = Object.fromEntries(result.checks.map((c) => [c.name, c.status]));
  return result;
}

const goodPdf = makePdf([`Glacier Retreat in the Alps by Erika Muster ${prose()}`, prose()]);

test("detects formats by content", () => {
  assert.equal(detectFormat(goodPdf.subarray(0, 64)), "pdf");
  assert.equal(detectFormat(Buffer.from("<!DOCTYPE html><html>")), "html");
  assert.equal(detectFormat(makeEpub({ title: "t", creator: "c", chapters: ["x"] }).subarray(0, 64)), "epub");
  assert.equal(detectFormat(Buffer.from("AT&TFORM....DJVU")), "djvu");
});

test("a matching, complete PDF passes", async () => {
  const r = await check("good.pdf", goodPdf);
  assert.equal(r.verdict, "pass", JSON.stringify(r.checks));
  assert.equal(r.format, "pdf");
});

test("an HTML page saved as PDF fails", async () => {
  const r = await check("paywall.pdf", Buffer.from("<html><body>Please log in</body></html>"));
  assert.equal(r.verdict, "fail");
  assert.equal(r.byName.format, "fail");
});

test("a truncated PDF fails", async () => {
  const r = await check("cut.pdf", makePdf([`Glacier Retreat in the Alps ${prose()}`], { truncate: true }));
  assert.equal(r.byName.opens, "fail");
});

test("a different work fails identity", async () => {
  const r = await check("other.pdf", makePdf([`Coral Reef Bleaching Patterns ${prose()}`, prose()]));
  assert.equal(r.byName.identity, "fail");
});

test("the DOI printed on page one settles identity", async () => {
  const meta = { ...META, title: "Something else entirely", doi: "10.1234/abc.5" };
  const r = await check("doi.pdf", makePdf([`doi 10.1234/abc.5 ${prose()}`, prose()]), { meta });
  assert.equal(r.byName.identity, "pass");
});

test("a page with no text layer is flagged, not rejected", async () => {
  const r = await check("scan.pdf", makePdf(["", ""]));
  assert.equal(r.byName["text-layer"], "warn");
  assert.equal(r.byName.identity, "warn");
  assert.equal(r.verdict, "warn");
});

test("a reference md5 must match", async () => {
  const r = await check("hash.pdf", goodPdf, { expected: { md5: "0".repeat(32) } });
  assert.equal(r.byName.hash, "fail");
});

test("a preview with far fewer pages than expected fails", async () => {
  const r = await check("preview.pdf", goodPdf, { meta: { ...META, pages: 30 } });
  assert.equal(r.byName.length, "fail");
});

test("disagreeing sources and missing fields put a work into review", async () => {
  const meta = { title: META.title, authors: [] };
  const candidates = [
    { source: "crossref", meta },
    { source: "openalex", meta: { title: "An unrelated book about cooking" } },
  ];
  const r = await check("meta.pdf", goodPdf, { meta, candidates });
  assert.equal(r.byName["metadata-complete"], "warn");
  assert.equal(r.byName["metadata-agreement"], "warn");
  assert.equal(r.verdict, "warn");
});

test("EPUB metadata and text are read", async () => {
  const epub = makeEpub({ title: META.title, creator: "Erika Muster", chapters: [prose(), prose()] });
  const r = await check("book.epub", epub);
  assert.equal(r.format, "epub");
  assert.equal(r.byName.identity, "pass");
  assert.equal(r.byName.author, "pass");
});
