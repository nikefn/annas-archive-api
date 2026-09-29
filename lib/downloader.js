/**
 * Download queue shared by scripts/queue-bookmarks.mjs and scripts/scheduler.mjs.
 *
 * The queue is a JSON array of { md5, title, folder, url, status, file?, ... }.
 * `status` is "pending", "failed" (retried up to MAX_ATTEMPTS), "done", or
 * "moved" (verified, then moved out of the download folder — never
 * downloaded again, and no longer expected in the folder).
 * An Anna's Archive md5 is the MD5 of the file itself, which makes it the
 * integrity check: a book only counts as done if its bytes hash to it.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { fastDownload, fetchMetadata } from "./annas.js";
import { checkIntegrity, safeName, sniffFile, truncateWords, withExtension } from "./filetype.js";
import { formatMetadataText } from "./metadata.js";

export const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_ERRORS = 5;
const FILE_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_BYTES = 64 * 1024 + 22;
const INVALID_DIR = "_invalid";
const MAX_METADATA_ATTEMPTS = 3;

export async function loadQueue(path) {
  return existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : [];
}

/** Write via a temp file so a crash mid-write can't corrupt the queue. */
export async function saveQueue(path, queue) {
  await writeFile(`${path}.tmp`, JSON.stringify(queue, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

/** Add newly found items; existing ones keep their status. Returns the new ones. */
export function mergeQueue(queue, found) {
  const known = new Set(queue.map((q) => q.md5));
  const added = found.filter((item) => !known.has(item.md5));
  queue.push(...added);
  return added;
}

export function isDownloadable(item) {
  return item.status === "pending" || (item.status === "failed" && (item.attempts || 0) < MAX_ATTEMPTS);
}

/** Bookmark titles end in " - Anna’s Archive"; bare-URL titles are no name. */
export function displayTitle(item) {
  if (item.meta?.title) return item.meta.title;
  const title = (item.title || "").replace(/\s*[-–]\s*Anna[’']s Archive\s*$/i, "").trim();
  return title && !/annas-archive\.|^https?:/i.test(title) ? title : item.md5;
}

/**
 * The file name (without extension) a book should have: "Title - Author"
 * from its Anna's Archive metadata when known, else the bookmark title, else
 * the md5. Cut at word boundaries so no name ends mid-word.
 */
export function bookName(item) {
  const title = item.meta?.title;
  if (!title) return safeName(displayTitle(item)) || item.md5;
  const authors = item.meta.authors ? ` - ${truncateWords(item.meta.authors, 60)}` : "";
  return safeName(`${truncateWords(title, 110)}${authors}`, 170) || item.md5;
}

/** Remember what naming needs; the full record lives in the .txt. */
function rememberMeta(item, meta) {
  item.meta = { title: meta.title, authors: meta.authors, year: meta.year };
}

function urlExtension(downloadUrl) {
  try {
    const ext = extname(decodeURIComponent(new URL(downloadUrl).pathname)).slice(1).toLowerCase();
    return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null;
  } catch {
    return null;
  }
}

/** `dir/name`, or `name (md5 prefix).ext` if another file already has it. */
function freePath(dir, name, md5) {
  const path = join(dir, name);
  if (!existsSync(path)) return path;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return join(dir, `${stem} (${(md5 || Date.now().toString(16)).slice(0, 8)})${ext}`);
}

/** "Book.pdf" → "Book.txt"; a book that is itself .txt gets "Book.metadata.txt". */
export function metadataPath(bookPath) {
  const ext = extname(bookPath);
  const stem = ext ? bookPath.slice(0, -ext.length) : bookPath;
  return ext.toLowerCase() === ".txt" ? `${stem}.metadata.txt` : `${stem}.txt`;
}

/**
 * Fetch an item's metadata and write it next to its book. Never throws: a
 * missing description shouldn't cost a book, so failures are recorded on the
 * item and retried by fillMetadata later.
 */
export async function writeMetadata(item, { key, tld, log = console.log, meta = null }) {
  try {
    meta ??= await fetchMetadata(item.md5, { key, tld });
    rememberMeta(item, meta);
    const file = metadataPath(item.file);
    const text = formatMetadataText(meta, {
      folder: item.folder,
      file: basename(item.file),
      fetched: new Date().toISOString().slice(0, 10),
    });
    await writeFile(file, text);
    item.metaFile = file;
    delete item.metaError;
    delete item.metaAttempts;
    return true;
  } catch (err) {
    item.metaError = err.message;
    item.metaAttempts = (item.metaAttempts || 0) + 1;
    log(`  metadata for ${displayTitle(item)} failed (attempt ${item.metaAttempts}/${MAX_METADATA_ATTEMPTS}): ${err.message}`);
    return false;
  }
}

function needsMetadata(item) {
  return (
    (item.status === "done" || item.status === "moved") &&
    item.file &&
    !(item.metaFile && existsSync(item.metaFile)) &&
    (item.metaAttempts || 0) < MAX_METADATA_ATTEMPTS
  );
}

/** Write metadata for every downloaded book that lacks it. Costs no fast downloads. */
export async function fillMetadata({ queue, key, tld, save, log = console.log }) {
  const todo = queue.filter(needsMetadata);
  let written = 0;
  for (const [i, item] of todo.entries()) {
    if (await writeMetadata(item, { key, tld, log })) {
      written++;
      log(`[${i + 1}/${todo.length}] metadata → ${basename(item.metaFile)}`);
    }
    await save();
  }
  return { written, failed: todo.length - written };
}

async function readEnds(path, size) {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(1024, size));
    await fh.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(TAIL_BYTES, size));
    await fh.read(tail, 0, tail.length, size - tail.length);
    return { head, tail };
  } finally {
    await fh.close();
  }
}

function md5File(path) {
  return new Promise((ok, fail) => {
    const hash = createHash("md5");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => ok(hash.digest("hex")));
  });
}

/**
 * Download queued books one at a time until the queue is empty, the account
 * is out of fast downloads, or the connection looks broken. Every file is
 * checked (type, completeness, md5) before it is written and marked done.
 */
export async function downloadBatch({ queue, dir, key, tld, save, log = console.log, metadata = true }) {
  await mkdir(dir, { recursive: true });
  const todo = queue.filter(isDownloadable);
  const result = { downloaded: 0, failed: 0, outOfQuota: false, stalled: false };
  let consecutiveErrors = 0;

  for (const [i, item] of todo.entries()) {
    const label = `[${i + 1}/${todo.length}] ${displayTitle(item)}`;
    // Metadata first (it's free): it gives the book its proper name.
    let meta = null;
    if (metadata) {
      try {
        meta = await fetchMetadata(item.md5, { key, tld });
        rememberMeta(item, meta);
      } catch {
        // Named from the bookmark instead; fillMetadata retries later.
      }
    }
    try {
      const data = await fastDownload(item.md5, key, { tld });
      if (!data.download_url) throw new Error("no download_url in response");
      const resp = await fetch(data.download_url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());

      const declared = Number(resp.headers.get("content-length"));
      if (declared && !resp.headers.get("content-encoding") && buf.length !== declared) {
        throw new Error(`incomplete download (${buf.length} of ${declared} bytes)`);
      }
      const type = sniffFile(buf);
      if (!type.valid) throw new Error(`got ${type.kind}`);
      const ext = type.ext || urlExtension(data.download_url) || "bin";
      const problem = checkIntegrity(ext, {
        head: buf.subarray(0, 1024),
        tail: buf.subarray(-TAIL_BYTES),
        size: buf.length,
      });
      if (problem) throw new Error(problem);
      const md5 = createHash("md5").update(buf).digest("hex");
      if (md5 !== item.md5) throw new Error(`checksum mismatch (file hashes to ${md5})`);

      const file = freePath(dir, `${bookName(item)}.${ext}`, item.md5);
      await writeFile(`${file}.part`, buf);
      await rename(`${file}.part`, file);
      const { size, mtimeMs } = await stat(file);
      Object.assign(item, { status: "done", file, verified: { size, mtimeMs } });
      delete item.error;
      result.downloaded++;
      consecutiveErrors = 0;
      log(`${label} … ok → ${basename(file)}`);
      if (metadata && (await writeMetadata(item, { key, tld, log, meta }))) {
        log(`  + ${basename(item.metaFile)}`);
      }
    } catch (err) {
      if (/no downloads left/i.test(err.message)) {
        // Out of quota: not this item's fault, and the rest would fail too.
        log(`${label} … no fast downloads left, batch ends here`);
        result.outOfQuota = true;
        break;
      }
      item.status = "failed";
      item.error = err.message;
      item.attempts = (item.attempts || 0) + 1;
      result.failed++;
      log(`${label} … failed (attempt ${item.attempts}/${MAX_ATTEMPTS}): ${err.message}`);
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(`${MAX_CONSECUTIVE_ERRORS} failures in a row — pausing this batch.`);
        result.stalled = true;
        await save();
        break;
      }
    }
    await save();
  }
  result.remaining = queue.filter(isDownloadable).length;
  return result;
}

/**
 * Check every file in `dir` and every "done" queue item, fixing what can be
 * fixed without a download:
 *  - wrong or missing extension → renamed to what the bytes say
 *  - unsafe filename → renamed to a safe one
 *  - error page, truncated file, or md5 mismatch → moved to _invalid/, re-queued
 *  - "done" item whose file is gone → "moved": it passed verification when it
 *    was downloaded, so a missing file means it was moved out (by hand, to
 *    anywhere), not lost. Only a book that was never verified is re-queued.
 * Returns { green, counts, red } where `red` lists what still needs a person.
 */
export async function verifyDir({ dir, queue, save, log = console.log }) {
  await mkdir(dir, { recursive: true });
  const byPath = new Map(queue.filter((q) => q.file).map((q) => [resolve(q.file), q]));
  const byMd5 = new Map(queue.map((q) => [q.md5, q]));
  const sidecars = new Set(queue.filter((q) => q.metaFile).map((q) => resolve(q.metaFile)));
  const counts = { ok: 0, renamed: 0, requeued: 0, untracked: 0, metadata: 0, noMetadata: 0 };
  const red = [];

  const requeue = async (path, name, item, why) => {
    await mkdir(join(dir, INVALID_DIR), { recursive: true });
    await rename(path, freePath(join(dir, INVALID_DIR), name));
    if (item?.metaFile && existsSync(item.metaFile)) {
      await rename(item.metaFile, freePath(join(dir, INVALID_DIR), basename(item.metaFile)));
    }
    if (item) {
      delete item.metaFile;
      item.status = "pending";
      item.error = why;
      delete item.file;
      delete item.verified;
    }
    counts.requeued++;
    log(`✗ ${name}: ${why} → moved to ${INVALID_DIR}/${item ? ", re-queued" : ""}`);
  };

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    try {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      let name = entry.name;
      let path = join(dir, name);
      if (sidecars.has(resolve(path))) continue; // a book's metadata .txt
      if (name.endsWith(".part") || name.endsWith(".tmp")) {
        await requeue(path, name, null, "unfinished download");
        continue;
      }
      if (!existsSync(path)) continue; // moved away while we were scanning
      const { size, mtimeMs } = await stat(path);
      let item = byPath.get(resolve(path));
      const { head, tail } = size ? await readEnds(path, size) : { head: Buffer.alloc(0), tail: Buffer.alloc(0) };
      const type = sniffFile(head);

      if (!type.valid) {
        await requeue(path, name, item, type.kind);
        continue;
      }
      const ext = type.ext || extname(name).slice(1).toLowerCase();
      if (!ext) {
        red.push(`${name}: unknown file type and no extension`);
        continue;
      }
      const problem = checkIntegrity(ext, { head, tail, size });
      if (problem) {
        await requeue(path, name, item, problem);
        continue;
      }

      // md5 is the expensive part, so skip files verified unchanged before.
      const cached = item?.verified;
      if (!(cached && cached.size === size && cached.mtimeMs === mtimeMs)) {
        const md5 = await md5File(path);
        if (item && md5 !== item.md5) {
          await requeue(path, name, item, `checksum mismatch (file hashes to ${md5})`);
          continue;
        }
        if (!item && byMd5.has(md5)) {
          // A known book whose queue entry lost track of the file.
          item = byMd5.get(md5);
          item.status = "done";
        }
      }
      if (!item) counts.untracked++;

      // Mobipocket covers .azw/.azw3/.prc too; keep those names as they are.
      const keepExt = type.ext === "mobi" && /\.(azw3?|prc)$/i.test(name);
      const stem = withExtension(name, ext).slice(0, -(ext.length + 1));
      const wantedStem = item ? bookName(item) : safeName(stem) || "book";
      const wanted = keepExt ? name : `${wantedStem}.${ext}`;
      // "Name (1a2b3c4d).ext" is the same name, disambiguated from another book.
      const disambiguated = item && name === `${wantedStem} (${item.md5.slice(0, 8)}).${ext}`;
      if (wanted !== name && !disambiguated) {
        const dest = freePath(dir, wanted, item?.md5);
        await rename(path, dest);
        log(`✓ ${name} → ${basename(dest)}`);
        if (item?.metaFile && existsSync(item.metaFile)) {
          // Keep the metadata file paired with its book's new name.
          const metaDest = metadataPath(dest);
          await rename(item.metaFile, metaDest);
          item.metaFile = metaDest;
          const text = await readFile(metaDest, "utf8");
          await writeFile(metaDest, text.replace(/^(Book file: +).*$/m, (_, label) => label + basename(dest)));
        }
        path = dest;
        name = basename(dest);
        counts.renamed++;
      } else {
        counts.ok++;
      }
      if (item) {
        const st = await stat(path);
        Object.assign(item, { file: path, verified: { size: st.size, mtimeMs: st.mtimeMs } });
      }
    } catch (err) {
      // Dragged away mid-check: nothing to verify; the missing-file pass
      // below records it as moved out.
      if (err.code !== "ENOENT") throw err;
    }
  }

  for (const item of queue) {
    if (item.status === "done" && item.file && existsSync(item.file)) {
      if (item.metaFile && existsSync(item.metaFile)) counts.metadata++;
      else counts.noMetadata++;
    }
    if (item.status === "done" && !(item.file && existsSync(item.file))) {
      if (item.verified) {
        item.status = "moved";
        item.movedAt = new Date().toISOString();
        log(`↳ ${displayTitle(item)}: no longer in the folder → marked moved out, won't be downloaded again`);
      } else {
        item.status = "pending";
        delete item.file;
        counts.requeued++;
        log(`✗ ${displayTitle(item)}: marked done but never verified and the file is missing → re-queued`);
      }
    }
  }
  counts.moved = queue.filter((q) => q.status === "moved").length;
  await save();
  return { green: red.length === 0, counts, red };
}

/**
 * Move every verified book (and its metadata .txt) from `dir` to `dest` and
 * mark it "moved", so neither verification nor the scheduler expects it back.
 * Also recognises books already moved to `dest` by hand: any file there whose
 * md5 matches a queued book marks that book "moved" — even if a verification
 * had already re-queued it after it went missing.
 */
export async function moveDone({ dir, dest, queue, save, log = console.log }) {
  if (resolve(dir) === resolve(dest)) throw new Error("the destination must be a different folder");
  await mkdir(dest, { recursive: true });
  const verify = await verifyDir({ dir, queue, save, log });
  const result = { moved: 0, recognised: 0, skipped: 0, verify };

  // 1. Hand-moved books: match files in dest by md5.
  const tracked = new Set(queue.filter((q) => q.file).map((q) => resolve(q.file)));
  const tracking = new Set(queue.filter((q) => q.metaFile).map((q) => resolve(q.metaFile)));
  const byMd5 = new Map(queue.filter((q) => q.status !== "moved").map((q) => [q.md5, q]));
  for (const entry of await readdir(dest, { withFileTypes: true })) {
    const path = join(dest, entry.name);
    if (!entry.isFile() || entry.name.startsWith(".") || tracked.has(resolve(path)) || tracking.has(resolve(path))) continue;
    if (extname(entry.name).toLowerCase() === ".txt") continue; // metadata, not a book
    const item = byMd5.get(await md5File(path));
    if (!item) continue;
    const { size, mtimeMs } = await stat(path);
    const meta = metadataPath(path);
    Object.assign(item, { status: "moved", file: path, verified: { size, mtimeMs } });
    if (existsSync(meta)) item.metaFile = meta;
    delete item.error;
    result.recognised++;
    log(`↳ ${entry.name}: already in ${dest}, marked moved`);
  }

  // 2. Verified books still in dir: move them with their .txt.
  for (const item of queue) {
    if (item.status !== "done" || !item.file || !existsSync(item.file)) continue;
    const { size, mtimeMs } = await stat(item.file);
    if (!(item.verified && item.verified.size === size && item.verified.mtimeMs === mtimeMs)) {
      result.skipped++; // changed since verification — leave it for the next check
      continue;
    }
    const target = freePath(dest, basename(item.file), item.md5);
    await rename(item.file, target);
    if (item.metaFile && existsSync(item.metaFile)) {
      const metaTarget = metadataPath(target);
      await rename(item.metaFile, metaTarget);
      item.metaFile = metaTarget;
    }
    const st = await stat(target);
    Object.assign(item, { status: "moved", file: target, verified: { size: st.size, mtimeMs: st.mtimeMs } });
    result.moved++;
    log(`→ ${basename(target)}`);
    await save();
  }
  await save();
  return result;
}

export function formatVerify({ green, counts, red }) {
  const summary =
    `${counts.ok} ok, ${counts.renamed} renamed, ${counts.requeued} re-queued` +
    (counts.moved ? `, ${counts.moved} moved out earlier` : "") +
    (counts.untracked ? `, ${counts.untracked} not from the queue` : "") +
    `; metadata ${counts.metadata}/${counts.metadata + counts.noMetadata}` +
    (counts.noMetadata ? ` (⚠ ${counts.noMetadata} missing)` : "");
  return green
    ? `✅ ALL GREEN — ${summary}`
    : `❌ ${red.length} problem(s) — ${summary}\n` + red.map((r) => `   • ${r}`).join("\n");
}
