import { test } from "node:test";
import assert from "node:assert/strict";

import { bookName } from "../lib/downloader.js";
import { safeName, truncateWords } from "../lib/filetype.js";

test("truncateWords never cuts mid-word", () => {
  assert.equal(truncateWords("Springer Nature Singapore Pte Ltd", 28), "Springer Nature Singapore");
  assert.equal(truncateWords("short", 28), "short");
});

test("safeName strips unsafe characters and trailing punctuation", () => {
  assert.equal(safeName('Visiting: the "Art" Museum?'), "Visiting_ the _Art_ Museum_");
  assert.equal(safeName("  ..Hidden. "), "Hidden");
});

test("bookName prefers metadata, then the bookmark title, then the md5", () => {
  const md5 = "886f91693b32738dbe9c156047fd46b6";
  assert.equal(
    bookName({ md5, meta: { title: "Bayesian Statistical Modeling with Stan, R, and Python", authors: "Kentaro Matsuura" } }),
    "Bayesian Statistical Modeling with Stan, R, and Python - Kentaro Matsuura"
  );
  assert.equal(bookName({ md5, title: "The Burnout Society - Anna’s Archive" }), "The Burnout Society");
  assert.equal(bookName({ md5, title: `annas-archive.pk/md5/${md5}` }), md5);
});
