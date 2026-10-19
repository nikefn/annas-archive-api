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
 *     .lock                                 held by the command that is changing works
 *
 * work.json fields: id, input, query, status (STATUSES; meanings in the README),
 * kind, added, updated, meta, file, checks, candidates, lookups, attempts (every
 * download ever tried), rejectedMd5s, tries (not_found runs in a row), waits
 * (outage runs in a row), nextTry, lastRunMs, error.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { config } from "./config.js";
import { ID_KINDS, normaliseId, parseInput, workId } from "./ids.js";

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

/**
 * Take the library lock for a command that changes existing works. Returns a
 * release function. A lock left by a process that no longer runs is taken over.
 */
export async function lock() {
  const path = join(config.library, ".lock");
  await mkdir(config.library, { recursive: true });
  for (;;) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx" });
      return () => rm(path, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      if (pid && pid !== process.pid && isAlive(pid)) throw new Error(`another litfetch command (pid ${pid}) is changing the library`);
      await rm(path, { force: true });
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Write atomically (own temp file, then rename) so a crash never leaves half a file. */
async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
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

/** All readable records, plus the folders in works/ whose record is missing or unreadable. */
export async function scan() {
  let entries;
  try {
    entries = await readdir(worksDir(), { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { works: [], broken: [] };
    throw err;
  }
  const works = [];
  const broken = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const work = await load(entry.name).catch(() => null);
    if (work) works.push(work);
    else broken.push(entry.name);
  }
  return { works: works.sort((a, b) => a.id.localeCompare(b.id)), broken };
}

export const list = async () => (await scan()).works;

/** The identifier a query is filed under, normalised, e.g. "doi 10.1/x". */
const identity = (query) => {
  const kind = ID_KINDS.find((k) => query[k]);
  return kind ? `${kind} ${normaliseId(kind, query[kind])}` : `title ${query.title}`;
};

/**
 * Queue one input line. `hints` carry metadata known up front (title, authors,
 * year, type, language), e.g. from an imported reference list or the web UI.
 * An existing work for the same identifier is left untouched. Two identifiers
 * whose folder names would collide get a hash suffix.
 */
export async function add(input, hints = {}) {
  const query = { ...hints, ...parseInput(input) };
  let id = workId(query);
  let existing = await load(id);
  if (existing && identity(existing.query) !== identity(query)) {
    id = `${id}-${createHash("sha1").update(identity(query)).digest("hex").slice(0, 8)}`;
    existing = await load(id);
  }
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
    waits: 0,
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

/** A CSV cell; text that a spreadsheet would run as a formula is prefixed with '. */
function csvCell(value) {
  const v = String(value).replace(/^[=+\-@]/, "'$&");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function writeIndex() {
  const works = await list();
  const rows = [INDEX_COLUMNS.map(([name]) => name)];
  for (const w of works) rows.push(INDEX_COLUMNS.map(([, get]) => get(w)));
  await mkdir(config.library, { recursive: true });
  await writeFile(join(config.library, "index.csv"), rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  return works;
}
