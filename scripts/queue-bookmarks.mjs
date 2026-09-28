#!/usr/bin/env node
/**
 * Scan a browser bookmark export for Anna's Archive book links and queue them.
 *
 *   node scripts/queue-bookmarks.mjs ~/Desktop/bookmarks.html
 *       Scan only. Writes bookmarks-queue.json and prints what was found.
 *
 *   ANNAS_KEY=... node scripts/queue-bookmarks.mjs ~/Desktop/bookmarks.html --download ~/Books
 *       Scan, then download each pending item one at a time. Re-running
 *       resumes: items already marked "done" are never downloaded again, and
 *       the run stops as soon as the account is out of fast downloads.
 *
 *   node scripts/queue-bookmarks.mjs --fix ~/Books
 *       Check files already downloaded: give each the extension its contents
 *       say it has, and move error pages to <dir>/_invalid/ and re-queue them.
 *
 * Options:
 *   --folders <regex>  Only scan folders whose name matches (default: whole file)
 *   --queue <file>     Queue file (default: bookmarks-queue.json)
 *   --download <dir>   Download pending items into <dir>
 *   --fix <dir>        Repair extensions of files in <dir> (no bookmarks needed)
 *   --tld <tld>        Mirror TLD, e.g. gd
 *
 * The key is read from ANNAS_KEY only, so it never lands in shell history as an
 * argument, and it is never written to the queue file or printed.
 */

import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { fastDownload } from "../lib/annas.js";
import { collectQueue } from "../lib/bookmarks.js";
import { sniffFile, withExtension } from "../lib/filetype.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    folders: { type: "string" },
    queue: { type: "string", default: "bookmarks-queue.json" },
    download: { type: "string" },
    fix: { type: "string" },
    tld: { type: "string" },
  },
});

// Merge with an existing queue so finished downloads keep their status.
let queue = [];
if (existsSync(values.queue)) {
  queue = JSON.parse(await readFile(values.queue, "utf8"));
}

const bookmarksPath = positionals[0];
if (values.fix) {
  await fixFiles(values.fix);
} else if (!bookmarksPath) {
  console.error(
    "Usage: node scripts/queue-bookmarks.mjs <bookmarks.html> [--download <dir>]\n" +
      "       node scripts/queue-bookmarks.mjs --fix <dir>"
  );
  process.exit(1);
}

if (bookmarksPath) {
  const html = await readFile(bookmarksPath, "utf8");
  const { queue: found, skipped } = collectQueue(
    html,
    values.folders ? new RegExp(values.folders, "i") : null
  );

  const known = new Set(queue.map((q) => q.md5));
  const added = found.filter((item) => !known.has(item.md5));
  queue.push(...added);
  await saveQueue();

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
  console.log(`\nQueue: ${values.queue} — ${queue.length - done} to download, ${done} done`);

  if (values.download) await downloadAll(values.download);
}

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

  // One at a time on purpose: fast downloads are metered per account.
  const todo = queue.filter((q) => q.status !== "done");
  for (const [i, item] of todo.entries()) {
    process.stdout.write(`\n[${i + 1}/${todo.length}] ${displayTitle(item)} … `);
    try {
      const { download_url } = await fastDownload(item.md5, key, { tld: values.tld });
      if (!download_url) throw new Error("no download_url in response");
      const resp = await fetch(download_url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const type = sniffFile(buf);
      if (!type.valid) throw new Error(`got ${type.kind}`);
      const ext = type.ext || urlExtension(download_url) || "bin";
      const file = await freePath(dir, `${baseName(item)}.${ext}`, item.md5);
      await writeFile(file, buf);
      item.status = "done";
      item.file = file;
      delete item.error;
      process.stdout.write(`ok → ${basename(file)}`);
    } catch (err) {
      if (/no downloads left/i.test(err.message)) {
        // Out of quota: this item didn't fail, and neither would the rest —
        // stop instead of spending a request on each of them.
        process.stdout.write("out of fast downloads");
        console.log(
          "\n\nNo fast downloads left on this account. Run the same command again " +
            "once they reset — finished books are skipped."
        );
        break;
      }
      item.status = "failed";
      item.error = err.message;
      process.stdout.write(`failed: ${err.message}`);
    }
    await saveQueue();
  }
  await saveQueue();
  console.log();
}

/**
 * Walk <dir>, give every book the extension its bytes say it has, and move
 * error pages to <dir>/_invalid/ so they are downloaded again next run.
 */
async function fixFiles(dir) {
  const byPath = new Map(queue.filter((q) => q.file).map((q) => [resolve(q.file), q]));
  const counts = { ok: 0, renamed: 0, invalid: 0, unknown: 0 };

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const item = byPath.get(resolve(path));
    const type = sniffFile(await readHead(path));

    if (!type.valid) {
      await mkdir(join(dir, "_invalid"), { recursive: true });
      await rename(path, join(dir, "_invalid", entry.name));
      if (item) {
        item.status = "pending";
        delete item.file;
      }
      counts.invalid++;
      console.log(`✗ ${entry.name}: ${type.kind} → moved to _invalid/${item ? ", re-queued" : ""}`);
    } else if (!type.ext) {
      counts.unknown++;
      console.log(`? ${entry.name}: unknown file type, left as is`);
    } else {
      const target = withExtension(entry.name, type.ext);
      if (target === entry.name) {
        counts.ok++;
        continue;
      }
      const dest = await freePath(dir, target, item?.md5);
      await rename(path, dest);
      if (item) item.file = dest;
      counts.renamed++;
      console.log(`✓ ${entry.name} → ${basename(dest)}`);
    }
  }
  await saveQueue();
  console.log(
    `\n${counts.ok} already fine, ${counts.renamed} renamed, ` +
      `${counts.invalid} invalid (re-queued), ${counts.unknown} unknown type`
  );
}

async function readHead(path) {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Bookmark titles end in " - Anna’s Archive"; bare-URL titles are no name. */
function displayTitle(item) {
  const title = (item.title || "").replace(/\s*[-–]\s*Anna[’']s Archive\s*$/i, "").trim();
  return title && !/annas-archive\.|^https?:/i.test(title) ? title : item.md5;
}

function baseName(item) {
  return displayTitle(item).replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 150).trim();
}

/** Fallback for types sniffFile can't name, e.g. plain-text formats. */
function urlExtension(downloadUrl) {
  try {
    const ext = extname(decodeURIComponent(new URL(downloadUrl).pathname)).slice(1).toLowerCase();
    return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null;
  } catch {
    return null;
  }
}

/** `dir/name`, or `name (md5 prefix).ext` if another book already has it. */
async function freePath(dir, name, md5) {
  const path = join(dir, name);
  if (!existsSync(path)) return path;
  const ext = extname(name);
  return join(dir, `${name.slice(0, -ext.length || undefined)} (${(md5 || Date.now().toString(16)).slice(0, 8)})${ext}`);
}
