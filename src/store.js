/**
 * The library on disk. Each work is one folder holding `work.json` (the single
 * source of truth for that work, queue state included) and, once fetched, its
 * file. `index.csv` is a derived overview, rebuilt from the records.
 *
 *   library/
 *     index.csv
 *     works/<work-id>/work.json
 *     works/<work-id>/<author>-<year>-<title>.<ext>
 *
 * Work status:  queued -> done | review | failed
 *   done    a file is kept and every check passed
 *   review  a file is kept but at least one check warned
 *   failed  no candidate produced an acceptable file
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "./config.js";
import { parseInput, workId } from "./ids.js";

export const STATUSES = ["queued", "done", "review", "failed"];

const worksDir = () => join(config.library, "works");
export const workDir = (id) => join(worksDir(), id);

export async function load(id) {
  try {
    return JSON.parse(await readFile(join(workDir(id), "work.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Write atomically (temp file + rename) so a crash never leaves half a record. */
export async function save(work) {
  work.updated = new Date().toISOString();
  const dir = workDir(work.id);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, "work.json.tmp");
  await writeFile(tmp, JSON.stringify(work, null, 2) + "\n");
  await rename(tmp, join(dir, "work.json"));
  return work;
}

export async function list() {
  let ids;
  try {
    ids = await readdir(worksDir());
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const works = await Promise.all(ids.map(load));
  return works.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Queue one input line. `hints` may carry known metadata (title, authors, year)
 * that helps matching, e.g. from the web UI. Existing works are left untouched.
 */
export async function add(input, hints = {}) {
  const query = { ...hints, ...parseInput(input) };
  const id = workId(query);
  const existing = await load(id);
  if (existing) return { work: existing, created: false };
  const now = new Date().toISOString();
  const work = {
    id,
    input: String(input).trim(),
    query,
    status: "queued",
    added: now,
    updated: now,
    meta: null,
    file: null,
    checks: [],
    attempts: [],
    error: null,
  };
  return { work: await save(work), created: true };
}

const INDEX_COLUMNS = [
  ["id", (w) => w.id],
  ["status", (w) => w.status],
  ["issues", (w) => w.checks.filter((c) => c.status !== "pass").map((c) => c.name).join(" ")],
  ["title", (w) => w.meta?.title ?? w.query.title ?? ""],
  ["first_author", (w) => w.meta?.authors?.[0] ?? ""],
  ["year", (w) => w.meta?.year ?? ""],
  ["doi", (w) => w.meta?.doi ?? w.query.doi ?? ""],
  ["format", (w) => w.file?.format ?? ""],
  ["source", (w) => w.file?.source ?? ""],
  ["file", (w) => (w.file ? `works/${w.id}/${w.file.name}` : "")],
  ["error", (w) => w.error ?? ""],
];

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export async function writeIndex() {
  const works = await list();
  const rows = [INDEX_COLUMNS.map(([name]) => name)];
  for (const w of works) rows.push(INDEX_COLUMNS.map(([, get]) => get(w)));
  await mkdir(config.library, { recursive: true });
  await writeFile(join(config.library, "index.csv"), rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  return works;
}
