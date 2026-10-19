/**
 * Response mappers of the source adapters, fed trimmed records in each API's
 * documented shape. Offline: no adapter's find() is called here.
 */

import "./env.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";

import * as arxiv from "../src/sources/arxiv.js";
import * as crossref from "../src/sources/crossref.js";
import * as dspace from "../src/sources/dspace.js";
import * as libgen from "../src/sources/libgen.js";
import * as openalex from "../src/sources/openalex.js";
import * as unpaywall from "../src/sources/unpaywall.js";
import * as url from "../src/sources/url.js";
import * as worldbank from "../src/sources/worldbank.js";
import * as zenodo from "../src/sources/zenodo.js";

test("crossref: metadata, retraction, only openly licensed PDF links", () => {
  const c = crossref.toCandidate({
    DOI: "10.1000/ABC",
    title: ["Main title"],
    subtitle: ["a subtitle"],
    author: [{ family: "Doe", given: "Jo" }, { name: "Some Consortium" }],
    issued: { "date-parts": [[2019, 5]] },
    page: "10-19",
    type: "journal-article",
    "updated-by": [{ type: "retraction", DOI: "10.1000/notice" }],
    license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }],
    link: [
      { URL: "https://pub.example/a.pdf", "content-type": "application/pdf", "content-version": "vor" },
      { URL: "https://pub.example/a.xml", "content-type": "text/xml" },
    ],
  });
  assert.equal(c.meta.title, "Main title: a subtitle");
  assert.deepEqual(c.meta.authors, ["Doe, Jo", "Some Consortium"]);
  assert.equal(c.meta.year, 2019);
  assert.equal(c.meta.pages, 10);
  assert.equal(c.meta.doi, "10.1000/abc");
  assert.equal(c.meta.retracted, true);
  assert.deepEqual(c.files.map((f) => f.url), ["https://pub.example/a.pdf"]);
});

test("openalex: OA locations with a pdf_url become files", () => {
  const c = openalex.toCandidate({
    display_name: "T",
    doi: "https://doi.org/10.1/X",
    publication_year: 2020,
    authorships: [{ author: { display_name: "Ada Lovelace" } }],
    biblio: { first_page: "5", last_page: "9" },
    ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/123", pmcid: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9" },
    best_oa_location: { pdf_url: "https://repo.example/t.pdf", version: "acceptedVersion" },
    locations: [{ pdf_url: null }, { pdf_url: "https://other.example/t.pdf" }],
  });
  assert.equal(c.meta.doi, "10.1/x");
  assert.equal(c.meta.pmid, "123");
  assert.equal(c.meta.pmcid, "PMC9");
  assert.equal(c.meta.pages, 5);
  assert.deepEqual(c.files.map((f) => f.url), ["https://repo.example/t.pdf", "https://other.example/t.pdf"]);
});

test("unpaywall: best location first", () => {
  const c = unpaywall.toCandidate({
    doi: "10.1/x",
    title: "T",
    z_authors: [{ family: "Doe", given: "J" }],
    best_oa_location: { url_for_pdf: "https://a.example/x.pdf", version: "publishedVersion", license: "cc-by" },
    oa_locations: [{ url_for_pdf: "https://b.example/x.pdf" }],
  });
  assert.deepEqual(c.meta.authors, ["Doe, J"]);
  assert.equal(c.files[0].license, "cc-by");
  assert.deepEqual(c.files.map((f) => f.url), ["https://a.example/x.pdf", "https://b.example/x.pdf"]);
});

test("arxiv: Atom entries", () => {
  const [c] = arxiv.parseFeed(`<feed xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
    <id>http://arxiv.org/abs/2101.00001v2</id><published>2021-01-01T00:00:00Z</published>
    <title>  A   Title </title><author><name>Ada Lovelace</name></author>
    <arxiv:doi>10.1/Y</arxiv:doi></entry></feed>`);
  assert.equal(c.meta.arxiv, "2101.00001");
  assert.equal(c.meta.title, "A Title");
  assert.equal(c.meta.doi, "10.1/y");
  assert.equal(c.files[0].url, "https://arxiv.org/pdf/2101.00001");
});

test("landing pages: citation_* meta tags", () => {
  const c = url.parseLandingPage(
    `<meta name="citation_title" content="Policy Brief 7">
     <meta name="citation_author" content="Doe, Jo">
     <meta name="citation_publication_date" content="2022/03/01">
     <meta name="citation_pdf_url" content="/files/brief7.pdf">`,
    "https://repo.example/item/7"
  );
  assert.equal(c.meta.title, "Policy Brief 7");
  assert.equal(c.meta.year, 2022);
  assert.deepEqual(c.files, [{ url: "https://repo.example/files/brief7.pdf" }]);
});

test("worldbank: documents object keyed by id, facets skipped", () => {
  const list = worldbank.parseResponse({
    documents: {
      D1: { id: "1", display_title: " Report A ", docdt: "2024-06-30T00:00:00Z", pdfurl: "https://documents.worldbank.org/a.pdf" },
      facets: {},
    },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].meta.title, "Report A");
  assert.equal(list[0].meta.year, 2024);
});

test("zenodo: document files with md5 checksums", () => {
  const c = zenodo.toCandidate({
    doi: "10.5281/zenodo.1",
    metadata: { title: "Deliverable 2.1", creators: [{ name: "Doe, Jo" }], publication_date: "2023-02-01" },
    files: [
      { key: "d21.pdf", checksum: "md5:abc", links: { self: "https://zenodo.org/f/d21.pdf" } },
      { key: "data.csv", checksum: "md5:def", links: { self: "https://zenodo.org/f/data.csv" } },
    ],
  });
  assert.deepEqual(c.files.map((f) => [f.url, f.md5]), [["https://zenodo.org/f/d21.pdf", "abc"]]);
});

test("dspace: item metadata and a lazily resolved bitstream", () => {
  const c = dspace.toCandidate(
    {
      uuid: "u1",
      handle: "10665/1",
      metadata: { "dc.title": [{ value: "Guideline" }], "dc.date.issued": [{ value: "2021" }] },
    },
    "https://iris.who.int"
  );
  assert.equal(c.meta.title, "Guideline");
  assert.equal(c.meta.url, "https://iris.who.int/handle/10665/1");
  assert.deepEqual(c.files, [{ dspace: { base: "https://iris.who.int", uuid: "u1" } }]);
});

test("libgen: identifiers from the results table, metadata from JSON", () => {
  const rows = libgen.parseSearchPage(`<table id="tablelibgen"><tr>
    <td><a href="edition.php?id=42">Title</a></td>
    <td><a href="/ads.php?md5=87A4EBDAF21FA6CC70009A3DD63194EE">mirror</a></td></tr></table>`);
  assert.deepEqual(rows, [{ editionId: "42", md5: "87a4ebdaf21fa6cc70009a3dd63194ee" }]);
  const c = libgen.toCandidate({ title: "Book", author: "A One; B Two", year: "2018", pages: "500" }, rows[0].md5);
  assert.deepEqual(c.meta.authors, ["A One", "B Two"]);
  assert.deepEqual(c.files, [{ md5: rows[0].md5 }]);
});
