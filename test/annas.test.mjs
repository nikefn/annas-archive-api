/**
 * Pure parts of the Anna's Archive adapter. Its routes and credit handling are
 * tested against a local stand-in for the site in annas-routes.test.mjs.
 */

import "./env.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseScidbPage, parseSearchResults, recordInfo } from "../src/sources/annas.js";

const BASE = "https://annas-archive.gl";
const results = parseSearchResults(readFileSync(new URL("./fixtures/annas-search.html", import.meta.url), "utf8"), BASE);

test("search results: one per card with a valid md5", () => {
  assert.deepEqual(results.map((r) => r.md5), [
    "0123456789abcdef0123456789abcdef",
    "fedcba9876543210fedcba9876543210",
    "00112233445566778899aabbccddeeff",
  ]);
});

test("search results: fields read from the card", () => {
  assert.deepEqual(results[0], {
    title: "Groundwater Recharge in Semi-Arid Basins",
    author: "Lima, Ana",
    format: "pdf",
    size: Math.round(12.5 * 1024 * 1024),
    content_type: "book_non_fiction",
    name: "lgli/Example Press/Groundwater Recharge.pdf",
    downloads: null,
    cover_url: "https://covers.example/a.jpg",
    url: `${BASE}/md5/0123456789abcdef0123456789abcdef`,
    md5: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(results[1].title, "Groundwater recharge estimates");
  assert.equal(results[1].content_type, "journal_article");
  assert.equal(results[1].cover_url, `${BASE}/covers/b.jpg`);
  assert.equal(results[1].author, "");
  assert.equal(results[2].format, "azw3");
  assert.equal(results[2].cover_url, null);
});

test("file records give name, size, content type and IPFS ids", () => {
  const info = recordInfo({
    file_unified_data: {
      original_filename_best: "scimag/10.1000/x.pdf",
      filesize_best: 123456,
      extension_best: "pdf",
      content_type_best: "journal_article",
      ipfs_infos: [{ ipfs_cid: "bafyexample", from: "x" }],
    },
  });
  assert.deepEqual(info, { name: "scimag/10.1000/x.pdf", size: 123456, format: "pdf", contentType: "journal_article", ipfs: ["bafyexample"] });
});

test("a SciDB page yields the PDF its viewer shows", () => {
  const page = '<iframe src="/pdfjs/web/viewer.html?file=https%3A%2F%2Ffiles.example%2Fa.pdf"></iframe>';
  assert.equal(parseScidbPage(page, `${BASE}/scidb/10.1/x`), "https://files.example/a.pdf");
  assert.equal(parseScidbPage("<p>nothing</p>", `${BASE}/scidb/10.1/x`), null);
});
