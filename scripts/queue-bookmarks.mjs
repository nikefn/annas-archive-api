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
 *   node scripts/queue-bookmarks.mjs --verify ~/Books --move-done ~/Library-Done
 *       Verify, then move every green book (with its .txt) to the other folder
 *       and mark it "moved" — it is never downloaded again. Books already
 *       dragged there by hand are recognised by md5 and marked too.
 *       Stop the scheduler first (or use its --move-to option instead).
 *
 *   node scripts/queue-bookmarks.mjs --status
 *       Progress report: books per status, metadata coverage, permanent
 *       failures, whether the scheduler runs, the next slots, recent batches.
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

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { fetchMetadata } from "../lib/annas.js";
import { collectQueue } from "../lib/bookmarks.js";
import {
  downloadBatch,
  moveDone,
  fillMetadata,
  formatVerify,
  isDownloadable,
  loadQueue,
  MAX_ATTEMPTS,
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
    "move-done": { type: "string" },
    status: { type: "boolean", default: false },
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

if (values.status) {
  printStatus();
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

if (verifyTarget && values["move-done"]) {
  const r = await moveDone({ dir: verifyTarget, dest: values["move-done"], queue, save });
  console.log(formatVerify(r.verify));
  console.log(
    `\nMoved ${r.moved} verified books to ${values["move-done"]}` +
      (r.recognised ? `; recognised ${r.recognised} already there` : "") +
      (r.skipped ? `; left ${r.skipped} that changed since verification` : "") +
      ". None of them will be downloaded again."
  );
  if (!r.verify.green) process.exitCode = 1;
} else if (verifyTarget) {
  const result = await verifyDir({ dir: verifyTarget, queue, save });
  console.log(formatVerify(result));
  if (!result.green) process.exitCode = 1;
}

function printStatus() {
  const by = (pred) => queue.filter(pred);
  const done = by((q) => q.status === "done");
  const moved = by((q) => q.status === "moved");
  const toGo = by(isDownloadable);
  const gaveUp = by((q) => q.status === "failed" && (q.attempts || 0) >= MAX_ATTEMPTS);
  const finished = done.length + moved.length;
  const withMeta = [...done, ...moved].filter((q) => q.metaFile && existsSync(q.metaFile)).length;
  const pct = queue.length ? Math.round((finished / queue.length) * 100) : 0;

  console.log(`Queue ${values.queue}: ${queue.length} books`);
  console.log(`  finished      ${finished} (${pct}%) — ${done.length} in the download folder, ${moved.length} moved out`);
  console.log(`  to download   ${toGo.length}`);
  console.log(`  gave up       ${gaveUp.length}${gaveUp.length ? " (failed " + MAX_ATTEMPTS + "×, need a look)" : ""}`);
  console.log(`  metadata      ${withMeta}/${finished} finished books have their .txt`);
  for (const q of gaveUp.slice(0, 10)) console.log(`    ✗ ${q.md5} ${q.title || ""}: ${q.error}`);

  let running = "not running";
  if (existsSync("scheduler.pid")) {
    const pid = Number(readFileSync("scheduler.pid", "utf8"));
    try {
      process.kill(pid, 0);
      running = `running (pid ${pid})`;
    } catch {
      running = "not running (stale scheduler.pid from a crash — safe to ignore)";
    }
  }
  console.log(`\nScheduler: ${running}`);
  if (existsSync("scheduler-state.json")) {
    const { wakes = [] } = JSON.parse(readFileSync("scheduler-state.json", "utf8"));
    const fmt = (t) => new Date(t).toLocaleString("sv-SE").slice(0, 16);
    for (const w of wakes.slice(0, 5)) {
      console.log(`  ${w.at < Date.now() ? "missed" : "next  "} ${fmt(w.at)}  ${w.why}`);
    }
    if (wakes.some((w) => w.at < Date.now())) console.log("  (missed slots run once as soon as the scheduler starts)");
  }
  if (existsSync("scheduler.log")) {
    const lines = readFileSync("scheduler.log", "utf8").trim().split("\n");
    const recent = lines.filter((l) => /■ Batch done|Verification:|Stopped|crashed/.test(l)).slice(-6);
    if (recent.length) console.log("\nRecent (scheduler.log):\n" + recent.map((l) => "  " + l).join("\n"));
    console.log(`  last log line: ${lines.at(-1)}`);
  }
}
