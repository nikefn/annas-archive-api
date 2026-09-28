import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { annasMd5, collectQueue } from "../lib/bookmarks.js";

const html = readFileSync(new URL("./fixtures/bookmarks.html", import.meta.url), "utf8");
const FOLDERS = /^(new_books|26_\d+_books)$/i;

test("queues md5 links from target folders and their subfolders only", () => {
  const { queue } = collectQueue(html, FOLDERS);
  assert.deepEqual(
    queue.map((q) => [q.folder, q.md5, q.title]),
    [
      ["new_books", "0123456789abcdef0123456789abcdef", "Dune & Friends"],
      ["new_books/sci-fi", "fedcba9876543210fedcba9876543210", "Nested, other mirror"],
      ["26_5_books", "11111111111111111111111111111111", "Fifth batch"],
    ]
  );
  assert.ok(queue.every((q) => q.status === "pending"));
});

test("reports non-md5 links and duplicates as skipped", () => {
  const { skipped } = collectQueue(html, FOLDERS);
  assert.deepEqual(
    skipped.map((s) => [s.folder, s.reason]),
    [
      ["new_books", "not an Anna's Archive /md5/ link"],
      ["26_1_books", "duplicate"],
      ["26_1_books", "not an Anna's Archive /md5/ link"],
    ]
  );
});

test("annasMd5 rejects look-alike hosts and malformed hashes", () => {
  assert.equal(annasMd5("https://annas-archive.evil.com/md5/0123456789abcdef0123456789abcdef"), null);
  assert.equal(annasMd5("https://annas-archive.gd/md5/xyz"), null);
  assert.equal(annasMd5("not a url"), null);
});
