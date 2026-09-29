#!/usr/bin/env node
/**
 * Scan a browser bookmark export for Anna's Archive book links and queue them.
 *
 *   node scripts/queue-bookmarks.mjs ~/Desktop/bookmarks.html
 *       Scan only. Writes bookmarks-queue.json and prints what was found.
 *
 *   ANNAS_KEY=... node scripts/queue-bookmarks.mjs ~/Desktop/bookmarks.html --download ~/Books
 *       Scan, download pending items one at a time until the account is out of
 *       fast downloads, then verify the folder. Finished books are never
 *       downloaded again. For unattended batches use scripts/scheduler.mjs.
 *
 *   node scripts/queue-bookmarks.mjs --verify ~/Books
 *       Check every file: type, extension, completeness, md5, filename. Fixes
 *       names in place; broken files go to <dir>/_invalid/ and are re-queued.
 *       (--fix is an alias.)
 *
 *   ANNAS_KEY=... node scripts/queue-bookmarks.mjs --metadata ~/Books
 *       Write "<book name>.txt" with Anna's Archive metadata (title, authors,
 *       publisher, year, ISBN/DOI, description, …) for every downloaded book
 *       that lacks one. Costs no fast downloads. New downloads get it anyway.
 *
 *   ANNAS_KEY=... node scripts/queue-bookmarks.mjs --probe <md5>
 *       Fetch and print one book's metadata — to check it works.
 *
 * Options:
 *   --folders <regex>  Only scan folders whose name matches (default: whole file)
 *   --queue <file>     Queue file (default: bookmarks-queue.json)
 *   --tld <tld>        Mirror TLD, e.g. gd
 *
 * The key is read from ANNAS_KEY only, so it never lands in shell history as an
 * argument, and it is never written to the queue file or printed.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { fetchMetadata } from "../lib/annas.js";
import { collectQueue } from "../lib/bookmarks.js";
import {
  downloadBatch,
  fillMetadata,
  formatVerify,
  loadQueue,
  mergeQueue,
  saveQueue,
  verifyDir,
} from "../lib/downloader.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    folders: { type: "string" },
    queue: { type: "string", default: "bookmarks-queue.json" },
    download: { type: "string" },
    verify: { type: "string" },
    fix: { type: "string" },
    metadata: { type: "string" },
    probe: { type: "string" },
    tld: { type: "string" },
  },
});

const queue = await loadQueue(values.queue);
const save = () => saveQueue(values.queue, queue);
const verifyTarget = values.verify || values.fix;
const bookmarksPath = positionals[0];

const key = process.env.ANNAS_KEY;
const needKey = () => {
  if (key) return key;
  console.error("Set ANNAS_KEY to your Anna's Archive account secret key.");
  process.exit(1);
};

if (values.probe) {
  const { formatMetadataText } = await import("../lib/metadata.js");
  const meta = await fetchMetadata(values.probe.trim().toLowerCase(), { key: needKey(), tld: values.tld });
  console.log(`(from ${meta.source})\n`);
  console.log(formatMetadataText(meta));
  process.exit(0);
}

if (!bookmarksPath && !verifyTarget && !values.metadata) {
  console.error(
    "Usage: node scripts/queue-bookmarks.mjs <bookmarks.html> [--download <dir>]\n" +
      "       node scripts/queue-bookmarks.mjs --verify <dir>"
  );
  process.exit(1);
}

if (bookmarksPath) {
  const html = await readFile(bookmarksPath, "utf8");
  const { queue: found, skipped } = collectQueue(
    html,
    values.folders ? new RegExp(values.folders, "i") : null
  );
  const added = mergeQueue(queue, found);
  await save();

  const byFolder = {};
  for (const item of found) byFolder[item.folder] = (byFolder[item.folder] || 0) + 1;
  console.log(`Found ${found.length} Anna's Archive links (${added.length} new):`);
  for (const [folder, n] of Object.entries(byFolder)) console.log(`  ${folder}: ${n}`);
  // Other sites and repeats are the bulk of a real export, so only count those.
  const count = (reason) => skipped.filter((s) => s.reason === reason).length;
  if (count("other site")) console.log(`\nIgnored ${count("other site")} links to other sites.`);
  if (count("duplicate")) console.log(`Ignored ${count("duplicate")} duplicate links (queued once).`);
  const notable = skipped.filter((s) => s.reason !== "other site" && s.reason !== "duplicate");
  if (notable.length) {
    console.log(`\nSkipped ${notable.length}:`);
    for (const s of notable) console.log(`  [${s.folder}] ${s.reason}: ${s.title || s.url}`);
  }
  const done = queue.filter((q) => q.status === "done").length;
  console.log(`\nQueue: ${values.queue} — ${queue.length - done} to download, ${done} done\n`);
}

if (values.download) {
  const r = await downloadBatch({ queue, dir: values.download, key: needKey(), tld: values.tld, save });
  console.log(`\n${r.downloaded} downloaded, ${r.failed} failed, ${r.remaining} still to download.`);
  if (r.outOfQuota) console.log("Out of fast downloads — run again once they reset.");
  console.log("\nVerifying…");
  console.log(formatVerify(await verifyDir({ dir: values.download, queue, save })));
}

if (values.metadata) {
  // Verify first so every book is tracked; fetched metadata then gives books
  // their "Title - Author" names, applied (with their .txt) by the last verify.
  await verifyDir({ dir: values.metadata, queue, save, log: () => {} });
  const m = await fillMetadata({ queue, key: needKey(), tld: values.tld, save });
  console.log(`\nMetadata: ${m.written} written, ${m.failed} failed.`);
  console.log(formatVerify(await verifyDir({ dir: values.metadata, queue, save })));
}

if (verifyTarget) {
  const result = await verifyDir({ dir: verifyTarget, queue, save });
  console.log(formatVerify(result));
  if (!result.green) process.exitCode = 1;
}
