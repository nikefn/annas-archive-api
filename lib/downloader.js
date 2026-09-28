/**
 * Download queue shared by scripts/queue-bookmarks.mjs and scripts/scheduler.mjs.
 *
 * The queue is a JSON array of { md5, title, folder, url, status, file?, ... }.
 * `status` is "pending", "failed" (retried up to MAX_ATTEMPTS) or "done".
 * An Anna's Archive md5 is the MD5 of the file itself, which makes it the
 * integrity check: a book only counts as done if its bytes hash to it.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { fastDownload } from "./annas.js";
import { checkIntegrity, safeName, sniffFile, withExtension } from "./filetype.js";

export const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_ERRORS = 5;
const FILE_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_BYTES = 64 * 1024 + 22;
const INVALID_DIR = "_invalid";

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
  const title = (item.title || "").replace(/\s*[-–]\s*Anna[’']s Archive\s*$/i, "").trim();
  return title && !/annas-archive\.|^https?:/i.test(title) ? title : item.md5;
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
export async function downloadBatch({ queue, dir, key, tld, save, log = console.log }) {
  await mkdir(dir, { recursive: true });
  const todo = queue.filter(isDownloadable);
  const result = { downloaded: 0, failed: 0, outOfQuota: false, stalled: false };
  let consecutiveErrors = 0;

  for (const [i, item] of todo.entries()) {
    const label = `[${i + 1}/${todo.length}] ${displayTitle(item)}`;
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

      const file = freePath(dir, `${safeName(displayTitle(item))}.${ext}`, item.md5);
      await writeFile(`${file}.part`, buf);
      await rename(`${file}.part`, file);
      const { size, mtimeMs } = await stat(file);
      Object.assign(item, { status: "done", file, verified: { size, mtimeMs } });
      delete item.error;
      result.downloaded++;
      consecutiveErrors = 0;
      log(`${label} … ok → ${basename(file)}`);
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
 *  - "done" item whose file is gone → re-queued
 * Returns { green, counts, red } where `red` lists what still needs a person.
 */
export async function verifyDir({ dir, queue, save, log = console.log }) {
  await mkdir(dir, { recursive: true });
  const byPath = new Map(queue.filter((q) => q.file).map((q) => [resolve(q.file), q]));
  const byMd5 = new Map(queue.map((q) => [q.md5, q]));
  const counts = { ok: 0, renamed: 0, requeued: 0, untracked: 0 };
  const red = [];

  const requeue = async (path, name, item, why) => {
    await mkdir(join(dir, INVALID_DIR), { recursive: true });
    await rename(path, freePath(join(dir, INVALID_DIR), name));
    if (item) {
      item.status = "pending";
      item.error = why;
      delete item.file;
      delete item.verified;
    }
    counts.requeued++;
    log(`✗ ${name}: ${why} → moved to ${INVALID_DIR}/${item ? ", re-queued" : ""}`);
  };

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    let name = entry.name;
    let path = join(dir, name);
    if (name.endsWith(".part") || name.endsWith(".tmp")) {
      await requeue(path, name, null, "unfinished download");
      continue;
    }
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
    const wanted = keepExt ? name : `${safeName(stem) || item?.md5 || "book"}.${ext}`;
    if (wanted !== name) {
      const dest = freePath(dir, wanted, item?.md5);
      await rename(path, dest);
      log(`✓ ${name} → ${basename(dest)}`);
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
  }

  for (const item of queue) {
    if (item.status === "done" && !(item.file && existsSync(item.file))) {
      item.status = "pending";
      delete item.file;
      delete item.verified;
      counts.requeued++;
      log(`✗ ${displayTitle(item)}: marked done but the file is missing → re-queued`);
    }
  }
  await save();
  return { green: red.length === 0, counts, red };
}

export function formatVerify({ green, counts, red }) {
  const summary =
    `${counts.ok} ok, ${counts.renamed} renamed, ${counts.requeued} re-queued` +
    (counts.untracked ? `, ${counts.untracked} not from the queue` : "");
  return green
    ? `✅ ALL GREEN — ${summary}`
    : `❌ ${red.length} problem(s) — ${summary}\n` + red.map((r) => `   • ${r}`).join("\n");
}
