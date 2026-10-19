import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInput, slug, workId } from "../src/ids.js";

test("recognises identifier kinds", () => {
  const cases = {
    "10.1038/nature12373": { doi: "10.1038/nature12373" },
    "https://doi.org/10.1038/NATURE12373": { doi: "10.1038/nature12373" },
    "doi: 10.1000/xyz123.": { doi: "10.1000/xyz123" },
    "arXiv:2101.00001v2": { arxiv: "2101.00001" },
    "https://arxiv.org/abs/hep-th/9901001": { arxiv: "hep-th/9901001" },
    "PMID: 12345678": { pmid: "12345678" },
    "PMC1234567": { pmcid: "PMC1234567" },
    "978-0-13-235088-4": { isbn: "9780132350884" },
    "0-306-40615-2": { isbn: "0306406152" },
    "md5:6C6B69B79ADAC1241C1706CEC47B4B89": { md5: "6c6b69b79adac1241c1706cec47b4b89" },
    "celex: 32016R0679": { celex: "32016R0679" },
    "symbol: A/RES/70/1": { symbol: "A/RES/70/1" },
    "https://example.org/report.pdf": { url: "https://example.org/report.pdf" },
  };
  for (const [input, expected] of Object.entries(cases)) assert.deepEqual(parseInput(input), expected, input);
});

test("anything else is a title", () => {
  assert.deepEqual(parseInput("  Attention Is All You Need "), { title: "Attention Is All You Need" });
  // Ten digits that fail the ISBN checksum are not an ISBN.
  assert.deepEqual(parseInput("1234567890"), { title: "1234567890" });
});

test("work ids are readable and stable", () => {
  assert.equal(workId({ doi: "10.1038/nature12373" }), "doi-10.1038-nature12373");
  assert.equal(workId({ symbol: "A/RES/70/1" }), "symbol-a-res-70-1");
  const t = workId({ title: "Ökonomie & Gesellschaft: eine Einführung" });
  assert.match(t, /^title-okonomie-gesellschaft-eine-einfuhrung-[0-9a-f]{8}$/);
  assert.equal(t, workId({ title: "Ökonomie & Gesellschaft: eine Einführung" }));
});

test("slugs are filesystem-safe", () => {
  assert.equal(slug("  A/B\\C:D*E?  "), "a-b-c-d-e");
  assert.equal(slug(""), "untitled");
});
