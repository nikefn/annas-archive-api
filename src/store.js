/**
 * The library on disk. Each work is one folder holding `work.json`, the single
 * source of truth for that work including its queue state, and the kept file.
 * `index.csv` is a derived overview, rebuilt from the records.
 *
 *   <library>/
 *     index.csv
 *     works/<work-id>/work.json
 *     works/<work-id>/<author>-<year>-<title>.<ext>
 *     _replaced/<work-id>/<time>-<file>    kept files that a better one replaced
 *     _state/<source>.json                  per-source state, e.g. download credits
 *
 * Status (see pipeline.js for the transitions):
 *   queued     waiting for its first run
 *   done       a file is kept and every check passed
 *   review     a file is kept, at least one check warned
 *   waiting    no file yet because a source was down or out of credits; retried after nextTry
 *   not_found  no source had an acceptable file; retried after nextTry, with growing gaps
 *   closed     set by the user; never retried
 *
 * work.json: id, input, query, status, kind, added, updated, meta, file, checks,
 * candidates, lookups, attempts (every download ever tried), rejectedMd5s,
 * tries (not_found runs in a row), nextTry, lastRunMs, error.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { config } from "./config.js";
import { parseInput, workId } from "./ids.js";

export const STATUSES = ["queued", "done", "review", "waiting", "not_found", "closed"];

const worksDir = () => join(config.library, "works");
export const workDir = (id) => join(worksDir(), id);
export const filePath = (work) => join(workDir(work.id), work.file.name);

/**
 * Why the library may not be used, or null. Downloads must never end up in a
 * git checkout unless git ignores that folder.
 */
export function libraryProblem(path = config.library) {
  let dir = path;
  while (!existsSync(dir)) dir = dirname(dir);
  let top;
  try {
    top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
  try {
    // Trailing slash: the library is a folder, and may not exist yet.
    execFileSync("git", ["-C", top, "check-ignore", "-q", `${path}/`], { stdio: "ignore" });
    return null;
  } catch {
    return `library ${path} is inside the git checkout ${top} and not git-ignored; set LITFETCH_LIBRARY to a folder outside it`;
  }
}

export function assertLibrary() {
  const problem = libraryProblem();
  if (problem) throw new Error(problem);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Write atomically (temp file + rename) so a crash never leaves half a file. */
async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

export const load = (id) => readJson(join(workDir(id), "work.json"));

export async function save(work) {
  work.updated = new Date().toISOString();
  await writeJson(join(workDir(work.id), "work.json"), work);
  return work;
}

export const readState = (name) => readJson(join(config.library, "_state", `${name}.json`));
export const writeState = (name, data) => writeJson(join(config.library, "_state", `${name}.json`), data);

/** Move a work's kept file to _replaced/ before a better one takes its place. */
export async function retire(work) {
  const dir = join(config.library, "_replaced", work.id);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(filePath(work), join(dir, `${stamp}-${work.file.name}`));
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
 * Queue one input line. `hints` carry metadata known up front (title, authors,
 * year, type, language), e.g. from an imported reference list or the web UI.
 * An existing work is left untouched.
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
    kind: null,
    added: now,
    updated: now,
    meta: null,
    file: null,
    checks: [],
    candidates: [],
    lookups: [],
    attempts: [],
    rejectedMd5s: [],
    tries: 0,
    nextTry: null,
    lastRunMs: null,
    error: null,
  };
  return { work: await save(work), created: true };
}

const INDEX_COLUMNS = [
  ["id", (w) => w.id],
  ["status", (w) => w.status],
  ["issues", (w) => w.checks.filter((c) => c.status !== "pass").map((c) => c.name).join(" ")],
  ["kind", (w) => w.kind ?? ""],
  ["title", (w) => w.meta?.title ?? w.query.title ?? ""],
  ["first_author", (w) => w.meta?.authors?.[0] ?? ""],
  ["year", (w) => w.meta?.year ?? ""],
  ["doi", (w) => w.meta?.doi ?? w.query.doi ?? ""],
  ["format", (w) => w.file?.format ?? ""],
  ["source", (w) => w.file?.source ?? ""],
  ["file", (w) => (w.file ? `works/${w.id}/${w.file.name}` : "")],
  ["next_try", (w) => w.nextTry ?? ""],
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
