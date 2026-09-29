import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMetadataText, parseRecordJson, parseRecordPage } from "../lib/metadata.js";

const record = {
  _source: {
    file_unified_data: {
      title_best: "The Burnout Society",
      author_best: "Byung-Chul Han",
      publisher_best: "Stanford University Press",
      edition_varia_best: "1st",
      year_best: "2015",
      language_codes: ["en"],
      extension_best: "epub",
      filesize_best: 1572864,
      identifiers_unified: { isbn13: ["9780804795098", "9780804795098"], doi: [] },
      stripped_description_best: "  An essay on   exhaustion. ",
    },
  },
};

test("parseRecordJson reads the unified 'best' fields", () => {
  const m = parseRecordJson(record);
  assert.equal(m.title, "The Burnout Society");
  assert.equal(m.authors, "Byung-Chul Han");
  assert.equal(m.format, "EPUB");
  assert.equal(m.size, "1.5 MB");
  assert.deepEqual(m.identifiers, { isbn13: ["9780804795098"] });
  assert.equal(m.description, "An essay on exhaustion.");
});

test("parseRecordPage falls back to the HTML record page", () => {
  const html = `<html><head><title>The Burnout Society - Anna’s Archive</title>
    <meta property="og:description" content="An essay."></head><body>
    <div class="text-3xl">The Burnout Society</div>
    <a href="/search?q=Han"><span class="icon-[mdi--user-edit]"></span> Byung-Chul Han</a>
    <div>English [en] · EPUB · 1.5MB · 2015 · 📘 Book (non-fiction)</div>
    <a href="/isbndb/9780804795098">isbn</a></body></html>`;
  const m = parseRecordPage(html);
  assert.equal(m.title, "The Burnout Society");
  assert.equal(m.authors, "Byung-Chul Han");
  assert.equal(m.format, "EPUB");
  assert.equal(m.year, "2015");
  assert.equal(m.language, "English [en]");
  assert.deepEqual(m.identifiers, { isbn13: ["9780804795098"] });
  assert.equal(m.description, "An essay.");
});

test("formatMetadataText aligns fields and skips empty ones", () => {
  const text = formatMetadataText(
    { ...parseRecordJson(record), md5: "a".repeat(32), url: "https://annas-archive.gd/md5/" + "a".repeat(32) },
    { folder: "26_1_books", file: "The Burnout Society.epub" }
  );
  assert.match(text, /^Title: +The Burnout Society$/m);
  assert.match(text, /^ISBN13: +9780804795098$/m);
  assert.match(text, /^Bookmark folder: +26_1_books$/m);
  assert.doesNotMatch(text, /^Content type:/m);
  assert.match(text, /\nDescription\n-----------\nAn essay on exhaustion\.\n$/);
});
