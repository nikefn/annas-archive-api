import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDownloadable, verifyDir } from "../lib/downloader.js";

const pdf = Buffer.from("%PDF-1.4 " + "x".repeat(2000) + "\n%%EOF\n", "latin1");
const md5 = createHash("md5").update(pdf).digest("hex");
const quiet = { save: async () => {}, log: () => {} };

test("a verified book moved out of the folder is marked moved, not re-queued", async () => {
  const dir = mkdtempSync(join(tmpdir(), "books-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  const file = join(dir, "Book.pdf");
  writeFileSync(file, pdf);
  const queue = [{ md5, title: "Book", status: "done", file }];

  await verifyDir({ dir, queue, ...quiet }); // verifies it
  renameSync(file, join(elsewhere, "Book.pdf")); // user drags it anywhere
  const result = await verifyDir({ dir, queue, ...quiet });

  assert.equal(queue[0].status, "moved");
  assert.equal(isDownloadable(queue[0]), false);
  assert.equal(result.counts.requeued, 0);
  assert.equal(result.counts.moved, 1);
});

test("a book that was never verified is re-queued when its file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "books-"));
  const queue = [{ md5, title: "Book", status: "done", file: join(dir, "gone.pdf") }];
  await verifyDir({ dir, queue, ...quiet });
  assert.equal(queue[0].status, "pending");
});
