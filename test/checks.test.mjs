import { scratch } from "./env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { checkFile } from "../src/checks/index.js";
import { workChecks } from "../src/checks/rules.js";
import { detectFormat } from "../src/checks/file.js";
import { makeEpub, makePdf, prose } from "./helpers.mjs";

const dir = scratch("checks");
const META = { title: "Glacier Retreat in the Alps", authors: ["Muster, Erika"], year: 2021, pages: 2 };

async function check(name, bytes, { meta = META, expected = {}, kind = "article", language } = {}) {
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
    kind,
    language,
    duplicates: new Map(),
  });
  result.byName = Object.fromEntries(result.checks.map((c) => [c.name, c.status]));
  return result;
}

const goodPdf = makePdf([`Glacier Retreat in the Alps by Erika Muster ${prose()}`, prose()]);
const english = "the river and the valley of the glacier is in the north and the ice that was on the hill ".repeat(4);
const german = "der Fluss und die Gletscher sind nicht mit dem Eis auf der Alm und das ist ein Tal ".repeat(4);

test("formats are detected by content", () => {
  assert.equal(detectFormat(goodPdf.subarray(0, 64)), "pdf");
  assert.equal(detectFormat(Buffer.from("<!DOCTYPE html><html>")), "html");
  assert.equal(detectFormat(Buffer.from('  {"error": "not found"}')), "json");
  assert.equal(detectFormat(makeEpub({ title: "t", creator: "c", chapters: ["x"] }).subarray(0, 64)), "epub");
  assert.equal(detectFormat(Buffer.from("AT&TFORM....DJVU")), "djvu");
});

test("a matching, complete PDF passes", async () => {
  const r = await check("good.pdf", goodPdf);
  assert.equal(r.verdict, "pass", JSON.stringify(r.checks));
  assert.equal(r.format, "pdf");
});

test("an HTML or JSON body fails, whatever it was served as", async () => {
  assert.equal((await check("login.pdf", Buffer.from("<html><body>Please log in</body></html>"))).byName.format, "fail");
  assert.equal((await check("error.pdf", Buffer.from('{"error":"no access"}'))).byName.format, "fail");
});

test("a truncated PDF or EPUB fails", async () => {
  const pdf = await check("cut.pdf", makePdf([`Glacier Retreat in the Alps ${prose()}`], { truncate: true }));
  assert.equal(pdf.byName.opens, "fail");
  const epub = makeEpub({ title: META.title, creator: "Erika Muster", chapters: [prose(), prose()] });
  const cut = await check("cut.epub", epub.subarray(0, epub.length - 30), { kind: "book" });
  assert.equal(cut.byName.opens, "fail");
});

test("a DRM-protected EPUB fails; font obfuscation alone does not", async () => {
  const base = { title: META.title, creator: "Erika Muster", chapters: [prose(), prose()] };
  const drm = await check("drm.epub", makeEpub({ ...base, encrypted: ["OEBPS/c0.xhtml"] }), { kind: "book" });
  assert.equal(drm.byName.drm, "fail");
  const fonts = await check("fonts.epub", makeEpub({ ...base, encrypted: ["OEBPS/fonts/a.otf"] }), { kind: "book" });
  assert.equal(fonts.byName.drm, undefined);
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

test("without an expected count a book needs 40 pages, an article 2", async () => {
  const meta = { ...META, pages: undefined };
  assert.equal((await check("short-book.pdf", goodPdf, { meta, kind: "book" })).byName.length, "fail");
  assert.equal((await check("article.pdf", goodPdf, { meta, kind: "article" })).byName.length, "pass");
});

test("a chapter printed from an online platform is not the book", async () => {
  const pages = [`Glacier Retreat in the Alps Erika Muster Page 1 of 2 ${prose()}`, `Page 2 of 2 ${prose()}`];
  const r = await check("printout.pdf", makePdf(pages), { kind: "book", meta: { ...META, pages: 2 } });
  assert.equal(r.byName.printout, "fail");
});

test("a text in another language than the work wants fails", async () => {
  const pdf = makePdf([`Glacier Retreat in the Alps Erika Muster ${german}`, german]);
  assert.equal((await check("de.pdf", pdf, { language: "en" })).byName.language, "fail");
  const en = makePdf([`Glacier Retreat in the Alps Erika Muster ${english}`, english]);
  assert.equal((await check("en.pdf", en, { language: "en" })).byName.language, "pass");
});

test("work checks: missing fields and disagreeing sources warn, whatever the file", () => {
  const meta = { title: META.title, authors: [] };
  const candidates = [
    { source: "crossref", tier: "same", meta },
    { source: "openalex", tier: "same", meta: { title: "An unrelated book about cooking" } },
  ];
  const byName = Object.fromEntries(workChecks({ meta, candidates }).map((c) => [c.name, c]));
  assert.equal(byName["metadata-complete"].status, "warn");
  assert.equal(byName["metadata-agreement"].status, "warn");
  assert.ok(Object.values(byName).every((c) => c.scope === "work"));
});

test("EPUB metadata and text are read", async () => {
  const epub = makeEpub({ title: META.title, creator: "Erika Muster", chapters: [prose(), prose()] });
  const r = await check("book.epub", epub, { kind: "book" });
  assert.equal(r.format, "epub");
  assert.equal(r.byName.identity, "pass");
  assert.equal(r.byName.author, "pass");
});
