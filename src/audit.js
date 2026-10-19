/**
 * Library audits. verify() checks the invariants that must always hold;
 * stats() computes the evaluation metrics (docs/eval.md) from the records.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "./config.js";
import * as store from "./store.js";

const SECRET_PATTERNS = [/[?&](key|api_key)=/i, /download_url/i, /aa_account/i];

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Invariants:
 *   - the library is not inside a git checkout (or is git-ignored)
 *   - every kept file exists and still has its recorded sha256
 *   - no record contains a key, a credited download URL or session data
 * Returns { errors, notes }; notes list works that share a file (each is in review).
 */
export async function verify() {
  const errors = [];
  const notes = [];
  const problem = store.libraryProblem();
  if (problem) errors.push(problem);

  const works = await store.list();
  const secrets = Object.values(config.keys).filter((k) => k.length >= 8);
  const holders = new Map();
  for (const w of works) {
    const raw = await readFile(join(store.workDir(w.id), "work.json"), "utf8");
    if (SECRET_PATTERNS.some((re) => re.test(raw)) || secrets.some((k) => raw.includes(k))) {
      errors.push(`${w.id}: record contains a key, download URL or session data`);
    }
    if (!w.file) continue;
    try {
      if ((await sha256(store.filePath(w))) !== w.file.sha256) errors.push(`${w.id}: file changed since it was checked`);
    } catch {
      errors.push(`${w.id}: kept file ${w.file.name} is missing`);
    }
    holders.set(w.file.sha256, [...(holders.get(w.file.sha256) ?? []), w.id]);
  }
  for (const ids of holders.values()) if (ids.length > 1) notes.push(`same file: ${ids.join(", ")}`);
  return { errors, notes };
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** [label, value] rows over all works. */
export async function stats() {
  const works = await store.list();
  const open = works.filter((w) => w.status !== "closed");
  const kept = open.filter((w) => w.file);
  const attempts = works.flatMap((w) => w.attempts.map((a) => ({ ...a, work: w })));
  const credited = attempts.filter((a) => a.credit);
  const fromCredits = kept.filter((w) => w.file.credit);
  const bookAttempts = attempts.filter((a) => a.work.kind === "book" && a.md5);
  const excerpts = bookAttempts.filter((a) => /^(length|printout):/.test(a.reason ?? ""));
  const pairs = new Map();
  for (const a of attempts.filter((a) => a.md5)) pairs.set(`${a.work.id} ${a.md5}`, (pairs.get(`${a.work.id} ${a.md5}`) ?? 0) + 1);
  const gold = open.filter((w) => w.query.gold);
  const ms = median(works.map((w) => w.lastRunMs));
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

  return [
    ["works", works.length],
    ...store.STATUSES.map((s) => [`  ${s}`, works.filter((w) => w.status === s).length]),
    ["yield (file kept / not closed)", pct(kept.length, open.length)],
    ["  passed every check", pct(kept.filter((w) => w.status === "done").length, open.length)],
    ["downloads tried", attempts.length],
    ["credited links handed out", credited.length],
    ["credited links per file kept from credits", fromCredits.length ? (credited.length / fromCredits.length).toFixed(2) : "-"],
    ["excerpt rejects per 100 book downloads", bookAttempts.length ? ((100 * excerpts.length) / bookAttempts.length).toFixed(1) : "-"],
    ["repeat downloads (same work and md5)", [...pairs.values()].filter((n) => n > 1).length],
    ["waiting on an outage", works.filter((w) => w.status === "waiting").length],
    ["median seconds per work, last run", ms === null ? "-" : (ms / 1000).toFixed(1)],
    ["gold: kept file matches", gold.length ? `${gold.filter((w) => w.file?.md5 === w.query.gold).length} of ${gold.length}` : "-"],
  ];
}
