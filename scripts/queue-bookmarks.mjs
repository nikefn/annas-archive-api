#!/usr/bin/env node
/**
 * Scan a browser bookmark export for Anna's Archive book links and queue them.
 *
 *   node scripts/queue-bookmarks.mjs ~/Desktop/bookmarks.html
 *       Scan only. Writes bookmarks-queue.json and prints what was found.
 *
 *   ANNAS_KEY=... node scripts/queue-bookmarks.mjs ~/Desktop/bookmarks.html --download ~/Books
 *       Scan, then download each pending item one at a time. Re-running
 *       resumes: items already marked "done" are skipped.
 *
 * Options:
 *   --folders <regex>  Folder names to scan (default: ^(new_books|26_\d+_books)$)
 *   --queue <file>     Queue file (default: bookmarks-queue.json)
 *   --download <dir>   Download pending items into <dir>
 *   --tld <tld>        Mirror TLD, e.g. gd
 *
 * The key is read from ANNAS_KEY only, so it never lands in shell history as an
 * argument, and it is never written to the queue file or printed.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { fastDownload } from "../lib/annas.js";
import { collectQueue } from "../lib/bookmarks.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    folders: { type: "string", default: "^(new_books|26_\\d+_books)$" },
    queue: { type: "string", default: "bookmarks-queue.json" },
    download: { type: "string" },
    tld: { type: "string" },
  },
});

const bookmarksPath = positionals[0];
if (!bookmarksPath) {
  console.error("Usage: node scripts/queue-bookmarks.mjs <bookmarks.html> [--download <dir>]");
  process.exit(1);
}

const html = await readFile(bookmarksPath, "utf8");
const { queue: found, skipped } = collectQueue(html, new RegExp(values.folders, "i"));

// Merge with an existing queue so finished downloads keep their status.
let queue = [];
if (existsSync(values.queue)) {
  queue = JSON.parse(await readFile(values.queue, "utf8"));
}
const known = new Set(queue.map((q) => q.md5));
const added = found.filter((item) => !known.has(item.md5));
queue.push(...added);
await saveQueue();

const byFolder = {};
for (const item of found) byFolder[item.folder] = (byFolder[item.folder] || 0) + 1;
console.log(`Found ${found.length} Anna's Archive links (${added.length} new):`);
for (const [folder, n] of Object.entries(byFolder)) console.log(`  ${folder}: ${n}`);
if (skipped.length) {
  console.log(`\nSkipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  [${s.folder}] ${s.reason}: ${s.title || s.url}`);
}
const pending = queue.filter((q) => q.status !== "done");
console.log(`\nQueue: ${values.queue} — ${pending.length} pending, ${queue.length - pending.length} done`);

if (values.download) await downloadAll(values.download);

async function saveQueue() {
  await writeFile(values.queue, JSON.stringify(queue, null, 2) + "\n");
}

async function downloadAll(dir) {
  const key = process.env.ANNAS_KEY;
  if (!key) {
    console.error("\nSet ANNAS_KEY to your Anna's Archive account secret key to download.");
    process.exit(1);
  }
  await mkdir(dir, { recursive: true });

  // One at a time on purpose: fast downloads are metered per account, and a
  // failure should stop a run from burning through the daily allowance.
  for (const item of queue.filter((q) => q.status !== "done")) {
    process.stdout.write(`\n↓ ${item.title || item.md5} … `);
    try {
      const { download_url } = await fastDownload(item.md5, key, { tld: values.tld });
      if (!download_url) throw new Error("no download_url in response");
      const resp = await fetch(download_url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const file = join(dir, fileName(item, download_url));
      await writeFile(file, Buffer.from(await resp.arrayBuffer()));
      item.status = "done";
      item.file = file;
      delete item.error;
      process.stdout.write("ok");
    } catch (err) {
      item.status = "failed";
      item.error = err.message;
      process.stdout.write(`failed: ${err.message}`);
    }
    await saveQueue();
  }
  console.log();
}

/** Upstream URLs end in a readable filename; fall back to the md5. */
function fileName(item, downloadUrl) {
  let name = "";
  try {
    name = decodeURIComponent(basename(new URL(downloadUrl).pathname));
  } catch {}
  name = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 200);
  return name.includes(".") ? name : `${item.md5}${name ? `_${name}` : ""}`;
}
