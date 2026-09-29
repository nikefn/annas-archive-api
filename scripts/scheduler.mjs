#!/usr/bin/env node
/**
 * Unattended batch downloader. Leave it running; it downloads whenever fast
 * downloads should be available and verifies the folder after every batch.
 *
 *   ANNAS_KEY=... node scripts/scheduler.mjs ~/Desktop/bookmarks.html --dir ~/Books \
 *     --at 17:00 --at 00:00 --every 18
 *
 * Fast downloads come back 18 hours after each one is used (a rolling window).
 * Two ways to follow that:
 *
 *  - Fixed slots (--every <hours>): each --at time starts a series that
 *    repeats every <hours> — 17:00 → 11:00 → 05:00 → 23:00 → … — whether or
 *    not the previous batch found credits. Only network trouble adds retries.
 *  - Following the credits (no --every): --at times run once; after that every
 *    batch schedules a follow-up 18h after its first download and another 18h
 *    after its last. A batch that finds no credits retries every 30 min.
 *
 * The quota itself is never configured: a batch simply runs until the account
 * answers "No downloads left". Credits added later need only a new --at slot at
 * the time they first become available.
 *
 * The schedule is kept in scheduler-state.json so a restart doesn't lose it; a
 * slot missed while the scheduler was stopped runs once on restart.
 *
 * Options:
 *   --dir <dir>         Download folder (required)
 *   --at <HH:MM>        Local start time; repeatable. The first run is its next
 *                       occurrence.
 *   --every <hours>     Repeat each --at slot every <hours> (e.g. 18).
 *   --now               Also run a batch right away.
 *   --window <hours>    Credit reset window (default 18)
 *   --folders <regex>   Only queue links from matching folders
 *   --queue <file>      Queue file (default: bookmarks-queue.json)
 *   --log <file>        Log file (default: scheduler.log)
 *   --tld <tld>         Mirror TLD, e.g. gd
 *
 * Every book gets "<book name>.txt" with its Anna's Archive metadata; any
 * that are missing (e.g. a lookup failed) are filled in after each batch.
 *
 * On macOS it runs `caffeinate` for its own lifetime so the Mac doesn't sleep.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { collectQueue } from "../lib/bookmarks.js";
import {
  downloadBatch,
  fillMetadata,
  formatVerify,
  isDownloadable,
  loadQueue,
  mergeQueue,
  saveQueue,
  verifyDir,
} from "../lib/downloader.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string" },
    at: { type: "string", multiple: true, default: [] },
    now: { type: "boolean", default: false },
    every: { type: "string" },
    window: { type: "string", default: "18" },
    folders: { type: "string" },
    queue: { type: "string", default: "bookmarks-queue.json" },
    log: { type: "string", default: "scheduler.log" },
    state: { type: "string", default: "scheduler-state.json" },
    tld: { type: "string" },
  },
});

const bookmarksPath = positionals[0];
const key = process.env.ANNAS_KEY;
if (!bookmarksPath || !values.dir) {
  console.error("Usage: ANNAS_KEY=... node scripts/scheduler.mjs <bookmarks.html> --dir <dir> [--at HH:MM ...] [--now]");
  process.exit(1);
}
if (!key) {
  console.error("Set ANNAS_KEY to your Anna's Archive account secret key.");
  process.exit(1);
}

const HOUR = 60 * 60 * 1000;
const WINDOW_MS = Number(values.window) * HOUR;
const RETRY_MS = 30 * 60 * 1000;
const MERGE_MS = 10 * 60 * 1000; // wake-ups this close together run as one
const RESET_MARGIN_MS = 2 * 60 * 1000;
const EVERY_MS = values.every ? Number(values.every) * HOUR : null;
if (values.every && !(EVERY_MS >= HOUR)) {
  console.error(`--every expects a number of hours (at least 1), got "${values.every}"`);
  process.exit(1);
}

const stamp = (t = Date.now()) => new Date(t).toLocaleString("sv-SE").slice(0, 16);
function log(line) {
  const out = `${stamp()}  ${line}`;
  console.log(out);
  appendFileSync(values.log, out + "\n");
}

if (process.platform === "darwin") {
  // -i: no idle sleep, -s: no system sleep on AC power, -w: until we exit.
  spawn("caffeinate", ["-is", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
}

// --- schedule --------------------------------------------------------------

function nextOccurrence(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`--at expects HH:MM, got "${hhmm}"`);
  const t = new Date();
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

let wakes = [];
if (existsSync(values.state)) {
  wakes = JSON.parse(readFileSync(values.state, "utf8")).wakes || [];
}
const saveState = () => writeFileSync(values.state, JSON.stringify({ wakes }, null, 2) + "\n");

/**
 * A wake is { at, why } plus, for a fixed slot, { series, repeatMs }. Slots
 * are never merged away; one-off wakes within MERGE_MS of another are.
 */
function addWake(t, why, slot = null) {
  if (!slot && wakes.some((w) => Math.abs(w.at - t) < MERGE_MS)) return;
  wakes.push({ at: t, why, ...slot });
  wakes.sort((a, b) => a.at - b.at);
  saveState();
}
function takeWake() {
  const w = wakes.shift();
  if (w.repeatMs) {
    // Next slot in the series that is still ahead of us.
    let next = w.at + w.repeatMs;
    while (next <= Date.now()) next += w.repeatMs;
    addWake(next, w.why, { series: w.series, repeatMs: w.repeatMs });
  }
  saveState();
  return w;
}

if (EVERY_MS) {
  // Fixed slots replace the credit-following schedule. Keep existing series
  // (so a restart doesn't reset them); start the ones not running yet.
  wakes = wakes.filter((w) => w.series && values.at.includes(w.series));
  for (const w of wakes) w.repeatMs = EVERY_MS;
  for (const hhmm of values.at) {
    if (!wakes.some((w) => w.series === hhmm)) {
      addWake(nextOccurrence(hhmm), `slot ${hhmm}, every ${values.every}h`, { series: hhmm, repeatMs: EVERY_MS });
    }
  }
  saveState();
} else {
  wakes = wakes.filter((w) => !w.series);
  for (const hhmm of values.at) addWake(nextOccurrence(hhmm), `start time ${hhmm}`);
}
if (values.now) addWake(Date.now(), "--now");

/**
 * Sleep in short steps against the wall clock: a single long setTimeout
 * drifts or stalls if the machine sleeps anyway.
 */
async function sleepUntil(t) {
  while (Date.now() < t) {
    await new Promise((r) => setTimeout(r, Math.min(60_000, t - Date.now())));
  }
}

// --- batches ---------------------------------------------------------------

const queue = await loadQueue(values.queue);
const save = () => saveQueue(values.queue, queue);

async function rescan() {
  const html = await readFile(bookmarksPath, "utf8");
  const { queue: found } = collectQueue(html, values.folders ? new RegExp(values.folders, "i") : null);
  const added = mergeQueue(queue, found);
  await save();
  if (added.length) log(`Queued ${added.length} new bookmarks.`);
}

async function verify(label) {
  const result = await verifyDir({ dir: values.dir, queue, save, log: (l) => log(`  ${l}`) });
  log(`${label}: ${formatVerify(result)}`);
  return result;
}

async function runBatch(why) {
  await rescan();
  const pending = queue.filter(isDownloadable).length;
  log(`▶ Batch (${why}) — ${pending} books to download`);
  const started = Date.now();
  let firstAt = null;
  let lastAt = null;
  const result = await downloadBatch({
    queue,
    dir: values.dir,
    key,
    tld: values.tld,
    save,
    log: (l) => {
      if (l.includes(" … ok")) {
        lastAt = Date.now();
        firstAt ??= lastAt;
      }
      log(`  ${l}`);
    },
  });
  const mins = Math.round((Date.now() - started) / 60000);
  log(
    `■ Batch done in ${mins} min: ${result.downloaded} downloaded, ${result.failed} failed, ` +
      `${result.remaining} left` + (result.outOfQuota ? " (out of fast downloads)" : "")
  );
  const meta = await fillMetadata({ queue, key, tld: values.tld, save, log: (l) => log(`  ${l}`) });
  if (meta.written || meta.failed) log(`Metadata catch-up: ${meta.written} written, ${meta.failed} failed.`);
  await verify("Verification");
  return { ...result, firstAt, lastAt };
}

// --- main loop ---------------------------------------------------------------

process.on("SIGINT", () => {
  log("Stopped by user. Run the same command to resume; the schedule is saved.");
  process.exit(0);
});

function logUpcoming() {
  const upcoming = wakes.slice(0, 4).map((w) => `${stamp(w.at)} (${w.why})`);
  if (upcoming.length) log(`Upcoming: ${upcoming.join(" · ")}`);
}

log(
  `Scheduler started — folder ${values.dir}, ` +
    (EVERY_MS ? `fixed slots ${values.at.join(" & ")} every ${values.every}h.` : `${values.window}h credit window.`)
);
logUpcoming();
await rescan();
await verify("Initial verification");

while (true) {
  if (!queue.some(isDownloadable)) {
    log("Queue is empty — every bookmarked book is downloaded.");
    await verify("Final verification");
    break;
  }
  if (!wakes.length) addWake(Date.now() + RETRY_MS, "retry");
  const next = wakes[0];
  log(`Next batch at ${stamp(next.at)} (${next.why}). Waiting…`);
  await sleepUntil(next.at);
  const wake = takeWake();

  let r;
  try {
    r = await runBatch(wake.why);
  } catch (err) {
    log(`Batch crashed: ${err.message} — retrying in 30 min.`);
    addWake(Date.now() + RETRY_MS, "retry after error");
    continue;
  }

  if (EVERY_MS) {
    // Fixed slots: the next slot comes regardless; only retry network trouble.
    if (r.stalled && (!wakes.length || wakes[0].at > Date.now() + RETRY_MS)) {
      addWake(Date.now() + RETRY_MS, "retry after errors");
    }
    logUpcoming();
    continue;
  }
  if (r.firstAt) addWake(r.firstAt + WINDOW_MS + RESET_MARGIN_MS, `credits from ${stamp(r.firstAt)} return`);
  if (r.lastAt) addWake(r.lastAt + WINDOW_MS + RESET_MARGIN_MS, `credits from ${stamp(r.lastAt)} return`);
  if (r.stalled || (r.outOfQuota && !r.downloaded)) {
    // Nothing moved: credits aren't back yet or the network is down. Check
    // again soon, unless a scheduled batch comes first anyway.
    if (!wakes.length || wakes[0].at > Date.now() + RETRY_MS) {
      addWake(Date.now() + RETRY_MS, r.stalled ? "retry after errors" : "retry, no credits yet");
    }
  }
}
process.exit(0);
