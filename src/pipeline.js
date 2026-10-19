/**
 * Process queued works:  gather -> merge -> download -> check -> keep best.
 *
 * gather    ask every active source for the work; keep candidates that match it
 * merge     one metadata record, fields taken in source-priority order
 * download  try candidate files in priority order, up to LITFETCH_MAX_ATTEMPTS
 * check     every file goes through checks/rules.js
 * keep      first "pass" wins; otherwise the first "warn"; "fail" is discarded
 */

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { checkFile } from "./checks/index.js";
import { config } from "./config.js";
import { download } from "./download.js";
import { ID_KINDS, normaliseId, slug } from "./ids.js";
import { activeSources } from "./sources/index.js";
import * as store from "./store.js";
import { coverage, similarity, surname, words } from "./text.js";

const TITLE_MATCH = 0.85;

/** Run every queued work (or those in `ids`). Returns the processed works. */
export async function run({ ids, onDone = () => {} } = {}) {
  const sources = activeSources();
  const all = await store.list();
  const duplicates = new Map(all.filter((w) => w.file).map((w) => [w.file.sha256, w.id]));
  const todo = all.filter((w) => (ids ? ids.includes(w.id) : w.status === "queued"));

  const done = [];
  const workers = Array.from({ length: Math.min(config.concurrency, todo.length) }, async () => {
    while (todo.length) {
      const work = todo.shift();
      await processWork(work, sources, duplicates);
      done.push(work);
      onDone(work);
    }
  });
  await Promise.all(workers);
  await store.writeIndex();
  return done;
}

export async function processWork(work, sources, duplicates = new Map()) {
  work.error = null;
  try {
    work.candidates = await gather(work.query, sources, (work.lookups = []));
    work.meta = mergeMeta(work.query, work.candidates);
    await fetchBest(work, sources, duplicates);
  } catch (err) {
    work.status = "failed";
    work.error = err.message;
  }
  return store.save(work);
}

/**
 * Search, then once more if the first round revealed new identifiers or a title:
 * sources that found nothing get the enriched query (e.g. a DOI-only work is then
 * also searched by title where a source cannot search by DOI).
 */
export async function gather(query, sources, lookups = []) {
  const ask = async (q, list) => {
    const results = await Promise.all(
      list.map(async (s) => {
        try {
          const found = (await s.find(q)).filter((c) => matches(q, c));
          lookups.push({ source: s.id, found: found.length });
          return found.map((c) => ({ source: s.id, ...c }));
        } catch (err) {
          lookups.push({ source: s.id, found: 0, error: err.message });
          return [];
        }
      })
    );
    return results.flat();
  };

  let candidates = await ask(query, sources);
  const merged = mergeMeta(query, candidates);
  const enriched = { ...idsOf(merged), title: merged.title, ...query };
  const gained = Object.keys(enriched).some((k) => enriched[k] && !query[k]);
  if (gained) {
    const answered = new Set(candidates.map((c) => c.source));
    candidates = candidates.concat(await ask(enriched, sources.filter((s) => !answered.has(s.id))));
  }
  const rank = (c) => sources.findIndex((s) => s.id === c.source);
  return candidates.sort((a, b) => rank(a) - rank(b));
}

/** Identifier values of a meta/query record, normalised, as { kind: [values] }. */
function idValues(record) {
  const out = {};
  for (const kind of ID_KINDS) {
    const v = record[kind];
    if (v) out[kind] = [].concat(v).map((x) => normaliseId(kind, x));
  }
  return out;
}

function idsOf(meta) {
  return Object.fromEntries(Object.entries(idValues(meta)).map(([k, v]) => [k, v[0]]));
}

/** A candidate belongs to the work if it shares an identifier or its title fits the input. */
export function matches(query, candidate) {
  const want = idValues(query);
  const have = idValues(candidate.meta);
  for (const kind of Object.keys(want)) {
    if (have[kind]?.some((v) => want[kind].includes(v))) return true;
  }
  if (!query.title || !candidate.meta.title) return false;
  if (words(candidate.meta.title).length < 2) return similarity(query.title, candidate.meta.title) >= TITLE_MATCH;
  return coverage(candidate.meta.title, query.title) >= TITLE_MATCH;
}

/** First non-empty value per field in source order; ids typed by the user win. */
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
  for (const kind of ID_KINDS) if (query[kind]) meta[kind] = query[kind];
  meta.title ??= query.title;
  meta.authors ??= query.authors;
  meta.year ??= query.year;
  return meta;
}

/** Ordered, de-duplicated list of candidate files. */
function rankFiles(candidates) {
  const seen = new Set();
  const files = [];
  for (const c of candidates) {
    for (const f of c.files ?? []) {
      const key = f.url || f.md5 || JSON.stringify(f);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ source: c.source, ...f });
    }
  }
  return files;
}

async function fetchBest(work, sources, duplicates) {
  const dir = store.workDir(work.id);
  const bySource = Object.fromEntries(sources.map((s) => [s.id, s]));
  const files = rankFiles(work.candidates).slice(0, config.maxAttempts);
  work.attempts = [];
  let best = null;

  for (const [i, expected] of files.entries()) {
    const tmp = join(dir, `candidate-${i}.tmp`);
    const attempt = { source: expected.source, url: expected.url ?? null };
    work.attempts.push(attempt);
    try {
      const source = bySource[expected.source];
      const link = source?.resolve ? await source.resolve(expected) : expected;
      if (link.md5) expected.md5 = link.md5;
      attempt.url = redact(link.url);
      const file = await download(link.url, tmp, { headers: link.headers });
      const others = new Map([...duplicates].filter(([, id]) => id !== work.id));
      const result = await checkFile({ path: tmp, file, expected, meta: work.meta, candidates: work.candidates, duplicates: others });
      attempt.verdict = result.verdict;
      const worst = result.checks.find((c) => c.status === result.verdict && c.status !== "pass");
      if (worst) attempt.reason = `${worst.name}: ${worst.detail}`;

      if (result.verdict === "fail" || (best && result.verdict !== "pass")) {
        await rm(tmp, { force: true });
        continue;
      }
      if (best) await rm(best.tmp, { force: true });
      best = { tmp, file, result, expected, url: link.url };
      if (result.verdict === "pass") break;
    } catch (err) {
      attempt.verdict = "fail";
      attempt.reason = err.message;
      await rm(tmp, { force: true });
    }
  }

  const previous = work.file;
  if (!best) {
    if (previous) await rm(join(dir, previous.name), { force: true });
    work.file = null;
    work.checks = [];
    work.status = "failed";
    const last = work.attempts.at(-1);
    work.error = files.length
      ? `all ${files.length} candidate files rejected; last: ${last.source} ${last.reason ?? last.verdict}`
      : "no source offered a file";
    return;
  }

  const name = `${fileStem(work.meta)}.${best.result.format}`;
  if (previous && previous.name !== name) await rm(join(dir, previous.name), { force: true });
  await rename(best.tmp, join(dir, name));
  work.file = {
    name,
    format: best.result.format,
    bytes: best.file.bytes,
    md5: best.file.md5,
    sha256: best.file.sha256,
    referenceMd5: best.expected.md5 ?? null,
    source: best.expected.source,
    url: redact(best.url),
    version: best.expected.version ?? null,
    license: best.expected.license ?? null,
  };
  work.checks = best.result.checks;
  work.status = best.result.verdict === "pass" ? "done" : "review";
  duplicates.set(best.file.sha256, work.id);
}

/** "<first-author>-<year>-<title>", readable and filesystem-safe. */
export function fileStem(meta) {
  const parts = [surname(meta.authors?.[0]), meta.year, meta.title].filter(Boolean);
  return slug(parts.join(" "), 80);
}

/** Drop credentials from a URL before it is written to disk. */
function redact(url) {
  try {
    const u = new URL(url);
    for (const key of ["key", "api_key", "apikey", "token"]) if (u.searchParams.has(key)) u.searchParams.set(key, "REDACTED");
    return u.toString();
  } catch {
    return url;
  }
}
