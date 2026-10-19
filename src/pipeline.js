/**
 * Process works:  gather -> merge -> try files -> keep the best -> settle status.
 *
 * gather  ask every active source; keep candidates that match the work
 * merge   one metadata record, each field from the first source that has it
 * try     candidate files in rank.js order, up to LITFETCH_MAX_ATTEMPTS downloads;
 *         each goes through the file checks, and the first that passes ends the search
 * keep    a file replaces the kept one only if it is strictly better (pass beats
 *         warn); the replaced file moves to _replaced/
 * settle  the kept file's checks plus the work checks give done or review; without
 *         a file, an outage gives waiting (not a try) and anything else not_found
 *
 * Works of one run share state: sources paused after a bot check, credited
 * links spent per work, and download failures per host.
 */

import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { checkFile } from "./checks/index.js";
import { verdictOf, workChecks } from "./checks/rules.js";
import { config } from "./config.js";
import { download } from "./download.js";
import { hostOf, isOutage } from "./http.js";
import { ID_KINDS, normaliseId, slug } from "./ids.js";
import { excerptSignal, rankFiles, workKind } from "./rank.js";
import { activeSources } from "./sources/index.js";
import * as store from "./store.js";
import { languageCode, normalise, surname, titleMatch } from "./text.js";

const NOT_FOUND_DAYS = [1, 3, 7, 14, 30];
const WAITING_HOURS = [6, 12, 24, 72, 168];
const HOUR = 3_600_000;
const QUALITY = { pass: 2, warn: 1 };

export const newRunState = () => ({ paused: new Map(), spent: new Map(), failures: new Map() });

/** Whether a work is due for a run at `now`. */
export function isDue(work, now = Date.now()) {
  if (work.status === "queued") return true;
  if (work.status !== "waiting" && work.status !== "not_found") return false;
  return !work.nextTry || Date.parse(work.nextTry) <= now;
}

/** Run every due work, or exactly the works in `ids`. A failing work does not stop the others. */
export async function run({ ids, onDone = () => {} } = {}) {
  store.assertLibrary();
  const sources = activeSources();
  const all = await store.list();
  const duplicates = new Map(all.filter((w) => w.file).map((w) => [w.file.sha256, w.id]));
  const todo = all.filter((w) => (ids ? ids.includes(w.id) : isDue(w)));
  const shared = newRunState();

  const done = [];
  const workers = Array.from({ length: Math.min(config.concurrency, todo.length) }, async () => {
    while (todo.length) {
      const work = todo.shift();
      try {
        await processWork(work, sources, { duplicates, shared });
      } catch (err) {
        work.error = `run failed: ${err.message}`;
        await store.save(work);
      }
      done.push(work);
      onDone(work);
    }
  });
  await Promise.all(workers);
  await store.writeIndex();
  return done;
}

export async function processWork(work, sources, { duplicates = new Map(), shared = newRunState() } = {}) {
  const started = Date.now();
  const outages = [];
  const firstAttempt = work.attempts.length;
  await removeLeftovers(work);
  work.error = null;
  work.lookups = [];
  work.candidates = await gather(work.query, sources, { lookups: work.lookups, outages, shared });
  work.meta = mergeMeta(work.query, work.candidates);
  work.kind = workKind(work.query, work.meta);
  const best = await tryFiles(work, sources, { duplicates, shared, outages });
  await settle(work, best, outages, work.attempts.slice(firstAttempt));
  if (best) duplicates.set(best.file.sha256, work.id);
  work.lastRunMs = Date.now() - started;
  return store.save(work);
}

/** Temp files an interrupted run left in the work's folder. */
async function removeLeftovers(work) {
  const dir = store.workDir(work.id);
  const names = await readdir(dir).catch(() => []);
  for (const name of names.filter((n) => /\.(tmp|part)$/.test(n))) await rm(join(dir, name), { force: true });
}

/** Note a source failure; a bot check pauses that source for the rest of the run. */
function noteOutage(source, err, { outages, shared }) {
  outages.push({ source, reason: err.message, retryAt: err.retryAt });
  if (err.code === "CHALLENGE") shared.paused.set(source, err.message);
}

/**
 * Ask every source once. If the answers reveal identifiers or a title the query
 * lacked, every answer is matched again against the enriched query, and the
 * sources that returned nothing are asked once more with it.
 */
export async function gather(query, sources, { lookups = [], outages = [], shared = newRunState() } = {}) {
  const raw = new Map(); // source id -> everything it returned

  const ask = (q, list) =>
    Promise.all(
      list.map(async (s) => {
        if (shared.paused.has(s.id)) {
          outages.push({ source: s.id, reason: shared.paused.get(s.id) });
          lookups.push({ source: s.id, found: 0, error: `paused: ${shared.paused.get(s.id)}` });
          return;
        }
        try {
          raw.set(s.id, (await s.find(q)).map((c) => ({ source: s.id, ...c })));
        } catch (err) {
          lookups.push({ source: s.id, found: 0, error: err.message });
          if (isOutage(err)) noteOutage(s.id, err, { outages, shared });
        }
      })
    );
  const matching = (q) =>
    [...raw.values()].flat().map((c) => ({ ...c, tier: matches(q, c) })).filter((c) => c.tier);

  await ask(query, sources);
  let q = query;
  const merged = mergeMeta(query, matching(query));
  const enriched = { ...idsOf(merged), title: merged.title, ...query };
  if (Object.keys(enriched).some((k) => enriched[k] && !query[k])) {
    q = enriched;
    await ask(q, sources.filter((s) => raw.has(s.id) && !raw.get(s.id).length));
  }
  const candidates = matching(q);
  for (const s of sources) {
    if (raw.has(s.id)) lookups.push({ source: s.id, found: candidates.filter((c) => c.source === s.id).length });
  }
  const rank = (c) => sources.findIndex((s) => s.id === c.source);
  return candidates.sort((a, b) => rank(a) - rank(b));
}

/** Identifier values of a record, normalised, as { kind: [values] }. */
function idValues(record) {
  const out = {};
  for (const kind of ID_KINDS) {
    const v = record[kind];
    if (v) out[kind] = [].concat(v).map((x) => normaliseId(kind, x));
  }
  return out;
}

const idsOf = (meta) => Object.fromEntries(Object.entries(idValues(meta)).map(([k, v]) => [k, v[0]]));

const sharesAuthor = (a = [], b = []) => {
  const names = new Set(a.map((n) => normalise(surname(n))));
  return b.some((n) => names.has(normalise(surname(n))));
};

/**
 * How a candidate matches the work: a titleMatch tier ("same", "other-edition",
 * "contained-in") or null. A shared identifier counts unless the candidate's
 * title and authors both contradict what the work is known to be.
 */
export function matches(query, candidate) {
  const want = idValues(query);
  const have = idValues(candidate.meta);
  const sharesId = Object.keys(want).some((k) => have[k]?.some((v) => want[k].includes(v)));
  const titled = Boolean(query.title && candidate.meta.title);
  const tier = titled ? titleMatch(query.title, candidate.meta.title) : null;
  if (!sharesId) return tier;
  if (tier || !titled || sharesAuthor(query.authors, candidate.meta.authors)) return tier ?? "same";
  return null;
}

/**
 * First non-empty value per field in source order; identifiers typed by the
 * user win. The language becomes an ISO 639-1 code where it can.
 */
export function mergeMeta(query, candidates) {
  const meta = {};
  for (const c of candidates) {
    for (const [k, v] of Object.entries(c.meta)) {
      if (meta[k] === undefined && v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) {
        meta[k] = v;
      }
    }
  }
  meta.retracted = candidates.some((c) => c.meta.retracted) || undefined;
  if (meta.language) meta.language = languageCode(meta.language) ?? meta.language;
  for (const kind of ID_KINDS) if (query[kind]) meta[kind] = query[kind];
  meta.title ??= query.title;
  meta.authors ??= query.authors;
  meta.year ??= query.year;
  return meta;
}

const fileVerdict = (checks) => verdictOf(checks.filter((c) => c.scope === "file"));

/** Quality of the kept file by its file checks: pass 2, otherwise 1; no file 0. */
const keptQuality = (work) => (work.file ? (fileVerdict(work.checks) === "pass" ? QUALITY.pass : QUALITY.warn) : 0);

async function tryFiles(work, sources, { duplicates, shared, outages }) {
  const kept = keptQuality(work);
  if (kept === QUALITY.pass) return null; // nothing can be strictly better than a pass

  const bySource = Object.fromEntries(sources.map((s) => [s.id, s]));
  const skip = [...work.rejectedMd5s, work.file?.md5, work.file?.referenceMd5].filter(Boolean);
  const queue = rankFiles(work.candidates, skip);
  const later = []; // for a book: likely excerpts, small PDFs before journal-article files
  const others = new Map([...duplicates].filter(([, id]) => id !== work.id));
  const dir = store.workDir(work.id);
  let best = null;
  let downloads = 0;

  while ((queue.length || later.length) && downloads < config.maxAttempts) {
    const fromLater = !queue.length;
    const file = queue.shift() ?? later.shift();
    const source = bySource[file.source];
    if (shared.paused.has(file.source)) {
      outages.push({ source: file.source, reason: shared.paused.get(file.source) });
      continue;
    }
    const isBook = work.kind === "book" && file.md5 !== work.query.md5;
    if (isBook && source.describe && !fromLater) {
      try {
        Object.assign(file, await source.describe(file));
      } catch (err) {
        // Down or out of credits: skip the file. Otherwise try it undescribed.
        if (isOutage(err)) {
          noteOutage(file.source, err, { outages, shared });
          continue;
        }
      }
    }
    const signal = isBook ? excerptSignal(file) : null;
    if (signal && !fromLater) {
      later.push(file);
      later.sort((a, b) => (excerptSignal(a) === "article") - (excerptSignal(b) === "article"));
      continue;
    }

    downloads++;
    const tmp = join(dir, `candidate-${work.attempts.length}.tmp`);
    const attempt = { at: new Date().toISOString(), source: file.source, url: file.url ?? null };
    work.attempts.push(attempt);
    const got = await fetchFirst(source, file, tmp, {
      work,
      shared,
      allowCredit: signal !== "article",
      onOutage: (err) => noteOutage(file.source, err, { outages, shared }),
    });
    if (got.credit) attempt.credit = true;
    if (!got.download) {
      attempt.verdict = "fail";
      attempt.reason = got.reason;
      continue;
    }

    const expectedMd5 = (got.md5 ?? file.md5)?.toLowerCase();
    attempt.md5 = got.download.md5;
    if (work.rejectedMd5s.includes(got.download.md5)) {
      attempt.verdict = "fail";
      attempt.reason = "rejected for this work before";
      await rm(tmp, { force: true });
      continue;
    }
    const result = await checkFile({
      path: tmp,
      file: got.download,
      expected: { md5: expectedMd5 },
      meta: work.meta,
      kind: work.kind,
      language: work.query.language,
      duplicates: others,
    });
    attempt.verdict = result.verdict;
    const worst = result.checks.find((c) => c.status === result.verdict && c.status !== "pass");
    if (worst) attempt.reason = `${worst.name}: ${worst.detail}`;

    if (result.verdict === "fail") {
      // A file that arrived as listed was judged on its content: never fetch it again for this work.
      if (!expectedMd5 || expectedMd5 === got.download.md5) work.rejectedMd5s.push(got.download.md5);
      await rm(tmp, { force: true });
      continue;
    }
    const quality = QUALITY[result.verdict];
    if (quality <= Math.max(kept, best?.quality ?? 0)) {
      await rm(tmp, { force: true });
      continue;
    }
    if (best) await rm(best.tmp, { force: true });
    best = { tmp, quality, result, file: got.download, listed: file, credit: got.credit, md5: expectedMd5 };
    if (quality === QUALITY.pass) break;
  }
  return best;
}

/**
 * Download the first working link a source offers for a file. Links come from
 * the source's links() (mirrors, gateways, signed URLs) or are the file's own
 * URL; only http(s) links are followed. An error from links() is an error of
 * the source. A failed download moves on to the next link, and a bot check on a
 * file URL means the file is not available there.
 */
async function fetchFirst(source, file, tmp, ctx) {
  const links = source.links ? source.links(file, ctx) : [{ url: file.url, headers: file.headers }];
  let reason = "no download link";
  let credit = false;
  try {
    for await (const link of links) {
      credit ||= Boolean(link.credit);
      if (!/^https?:\/\//i.test(link.url ?? "")) {
        reason = "not an http(s) link";
        continue;
      }
      try {
        return { download: await download(link.url, tmp, { headers: link.headers }), md5: link.md5, credit };
      } catch (err) {
        reason = err.message;
        const host = hostOf(link.url);
        ctx.shared.failures.set(host, (ctx.shared.failures.get(host) ?? 0) + 1);
        if (isOutage(err) && err.code !== "CHALLENGE") ctx.onOutage(err);
      }
    }
  } catch (err) {
    reason = err.message;
    if (isOutage(err)) ctx.onOutage(err);
  }
  return { download: null, reason, credit };
}

/** The gap for the n-th run in a row; the last one repeats. */
const gapFor = (gaps, n) => gaps[Math.min(n, gaps.length) - 1];

async function settle(work, best, outages, attempts) {
  const now = Date.now();
  if (best) {
    const name = `${fileStem(work.meta)}.${best.result.format}`;
    if (work.file) await store.retire(work);
    await rename(best.tmp, join(store.workDir(work.id), name));
    work.file = {
      name,
      format: best.result.format,
      bytes: best.file.bytes,
      md5: best.file.md5,
      sha256: best.file.sha256,
      referenceMd5: best.md5 ?? null,
      source: best.listed.source,
      url: best.listed.url ?? null,
      credit: best.credit || undefined,
      version: best.listed.version ?? null,
      license: best.listed.license ?? null,
    };
  }
  if (work.file) {
    const fileChecks = best ? best.result.checks : work.checks.filter((c) => c.scope === "file");
    work.checks = [...fileChecks, ...workChecks({ meta: work.meta, candidates: work.candidates })];
    work.status = verdictOf(work.checks) === "pass" ? "done" : "review";
    work.tries = 0;
    work.waits = 0;
    work.nextTry = null;
    return;
  }
  if (outages.length) {
    work.waits = (work.waits ?? 0) + 1;
    const fallback = now + gapFor(WAITING_HOURS, work.waits) * HOUR;
    work.status = "waiting";
    work.nextTry = new Date(Math.min(...outages.map((o) => Date.parse(o.retryAt) || fallback))).toISOString();
    work.error = `outage: ${[...new Set(outages.map((o) => `${o.source} (${o.reason})`))].join("; ")}`;
    return;
  }
  const last = attempts.at(-1);
  work.tries = (work.tries ?? 0) + 1;
  work.waits = 0;
  work.status = "not_found";
  work.nextTry = new Date(now + gapFor(NOT_FOUND_DAYS, work.tries) * 24 * HOUR).toISOString();
  work.error = last ? `no acceptable file; last: ${last.source} ${last.reason ?? last.verdict}` : "no source offered a file";
}

/** "<first-author>-<year>-<title>", readable and filesystem-safe. */
export function fileStem(meta) {
  const parts = [surname(meta.authors?.[0]), meta.year, meta.title].filter(Boolean);
  return slug(parts.join(" "), 80);
}
