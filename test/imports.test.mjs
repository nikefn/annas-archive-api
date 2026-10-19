import assert from "node:assert/strict";
import { test } from "node:test";

import { parseList } from "../src/imports.js";

test("BibTeX: identifier as input, the rest as hints", () => {
  const items = parseList(
    `@book{h1927,
      title = {Being and {Time}},
      author = {Heidegger, Martin and Macquarrie, John},
      year = 1962, isbn = {978-0-306-40615-7}, language = {english}
    }
    @article{k, doi = "10.1038/nature12373", title="Nanometre-scale thermometry in a living cell"}`,
    "refs.bib"
  );
  assert.deepEqual(items, [
    {
      input: "isbn:978-0-306-40615-7",
      hints: { title: "Being and Time", authors: ["Heidegger, Martin", "Macquarrie, John"], year: 1962, type: "book", language: "en" },
    },
    { input: "10.1038/nature12373", hints: { title: "Nanometre-scale thermometry in a living cell", type: "article" } },
  ]);
});

test("RIS records", () => {
  const items = parseList("TY  - RPRT\nTI  - Water Report\nAU  - Doe, J\nPY  - 2020/01/01\nLA  - German\nER  - \n", "x.ris");
  assert.deepEqual(items, [{ input: "Water Report", hints: { title: "Water Report", authors: ["Doe, J"], year: 2020, type: "report", language: "de" } }]);
});

test("TSV evaluation sets and plain lists", () => {
  assert.deepEqual(parseList("input\tkind\tlanguage\tgold\n10.1/x\tarticle\ten\t\n", "set.tsv"), [
    { input: "10.1/x", hints: { type: "article", language: "en" } },
  ]);
  assert.deepEqual(parseList("# reading list\n10.1/a\n\narXiv:1706.03762\n", "list.txt").map((i) => i.input), ["10.1/a", "arXiv:1706.03762"]);
});

test("BibTeX entry types become kinds the checks understand", () => {
  const types = parseList("@inbook{a, title={A}}\n@incollection{b, title={B}}\n@phdthesis{c, title={C}}\n@misc{d, title={D}}", "x.bib").map((i) => i.hints.type);
  assert.deepEqual(types, ["chapter", "chapter", "thesis", undefined]);
});

test("an empty TSV is an empty list", () => {
  assert.deepEqual(parseList("", "set.tsv"), []);
});
