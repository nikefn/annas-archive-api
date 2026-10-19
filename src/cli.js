#!/usr/bin/env node
/**
 * litfetch command line. Every command reads and writes the library through
 * store.js. `run` and `find` use the network; `recheck` does too when model
 * triage is on. Commands that change existing works hold the library lock.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { stats, verify } from "./audit.js";
import { checkFile } from "./checks/index.js";
import { llmEnabled } from "./checks/llm.js";
import { verdictOf, workChecks } from "./checks/rules.js";
import { config } from "./config.js";
import { toRis } from "./export.js";
import { parseInput } from "./ids.js";
import { parseList } from "./imports.js";
import { gather, run } from "./pipeline.js";
import { SOURCES, activeSources } from "./sources/index.js";
import * as store from "./store.js";

const HELP = `litfetch: queue, fetch and verify literature

  add <input...> [-f file]     queue works: DOI, arXiv id, ISBN, "pmid: ...", PMCID,
                               "md5: ...", "celex: ...", "symbol: ...", URL, or a title
                               or citation; -f reads a list, .bib, .ris or .tsv file
  run [id...]                  process the works that are due (or the given ones)
  status                       counts per status and what needs a look
  show <id>                    print one work record
  retry <id...> | --status s   queue works again now
  close <id...>                stop retrying works
  recheck [id...]              re-run the checks on kept files, no download
  find <input>                 ask the sources without queueing anything
  sources                      which sources are active, what the others need
  export                       RIS of the library on stdout, files attached
  stats                        evaluation metrics (docs/eval.md)
  verify                       check the library's invariants; exit 1 on errors

Library: ${config.library}
Settings: environment or .env, see .env.example`;

/** The works named in `ids`, or else those with `status`; unknown ids are an error. */
async function pick(ids, status) {
  const works = await store.list();
  if (!ids.length) return works.filter((w) => w.status === status);
  const unknown = ids.filter((id) => !works.some((w) => w.id === id));
  if (unknown.length) throw new Error(`no such work: ${unknown.join(", ")}`);
  return works.filter((w) => ids.includes(w.id));
}

/** Run `fn` holding the library lock. */
async function locked(fn) {
  const release = await store.lock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

const commands = {
  async add(args, opts) {
    const items = args.map((input) => ({ input, hints: {} }));
    if (opts.file) items.push(...parseList(await readFile(opts.file, "utf8"), opts.file));
    let added = 0;
    for (const { input, hints } of items) {
      const { work, created } = await store.add(input, hints);
      added += created;
      console.log(`${created ? "queued " : "exists "} ${work.id}`);
    }
    await store.writeIndex();
    console.log(`${added} added`);
  },

  run: (ids) =>
    locked(async () => {
      if (ids.length) await pick(ids);
      console.log(`sources: ${activeSources().map((s) => s.id).join(", ")}`);
      if (llmEnabled()) {
        console.log(`model triage on (${config.llmModels.join(", ")}): opening pages of uncertain files go to the Anthropic API`);
      }
      const done = await run({
        ids: ids.length ? ids : undefined,
        onDone: (w) => console.log(`${w.status.padEnd(9)} ${w.id}${w.error ? `  (${w.error})` : ""}`),
      });
      console.log(`${done.length} processed; overview in ${join(config.library, "index.csv")}`);
    }),

  async status() {
    const works = await store.list();
    for (const s of store.STATUSES) console.log(`${s.padEnd(9)} ${works.filter((w) => w.status === s).length}`);
    for (const w of works.filter((w) => ["review", "waiting", "not_found"].includes(w.status))) {
      const why =
        w.status === "review"
          ? w.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`).join("; ")
          : `${w.error}; next try ${w.nextTry}`;
      console.log(`\n${w.status} ${w.id}\n  ${why}`);
    }
  },

  async show([id]) {
    const work = await store.load(id);
    if (!work) throw new Error(`no such work: ${id}`);
    console.log(JSON.stringify(work, null, 2));
  },

  retry: (ids, opts) =>
    locked(async () => {
      if (!ids.length && !opts.status) throw new Error("name the works, or give --status");
      const works = await pick(ids, opts.status);
      for (const w of works) await store.save({ ...w, status: "queued", nextTry: null });
      await store.writeIndex();
      console.log(`${works.length} queued; a kept file is replaced only by a strictly better one`);
    }),

  close: (ids) =>
    locked(async () => {
      if (!ids.length) throw new Error("name the works to close");
      const works = await pick(ids);
      for (const w of works) await store.save({ ...w, status: "closed", nextTry: null });
      await store.writeIndex();
      console.log(`${works.length} closed`);
    }),

  recheck: (ids) =>
    locked(async () => {
      const all = await store.list();
      const holders = new Map(all.filter((w) => w.file).map((w) => [w.file.sha256, w.id]));
      const works = ids.length ? await pick(ids) : all.filter((w) => w.file && w.status !== "closed");
      for (const w of works.filter((w) => w.file)) {
        try {
          const result = await checkFile({
            path: store.filePath(w),
            file: w.file,
            expected: { md5: w.file.referenceMd5 },
            meta: w.meta,
            kind: w.kind,
            language: w.query.language,
            duplicates: new Map([...holders].filter(([, id]) => id !== w.id)),
          });
          w.checks = [...result.checks, ...workChecks({ meta: w.meta, candidates: w.candidates })];
          w.status = verdictOf(w.checks) === "pass" ? "done" : "review";
          await store.save(w);
          console.log(`${w.status.padEnd(9)} ${w.id}`);
        } catch (err) {
          console.log(`error     ${w.id}  (${err.message})`);
        }
      }
      await store.writeIndex();
    }),

  async find(args) {
    const query = parseInput(args.join(" "));
    const lookups = [];
    const candidates = await gather(query, activeSources(), { lookups });
    console.log(JSON.stringify({ query, lookups, candidates }, null, 2));
  },

  async sources() {
    const active = new Set(activeSources().map((s) => s.id));
    for (const s of Object.values(SOURCES)) {
      const listed = config.sources.includes(s.id);
      const missing = s.missing();
      const state = active.has(s.id)
        ? "active"
        : !listed
          ? `off (add to LITFETCH_SOURCES${missing.length ? `; needs ${missing.join(", ")}` : ""})`
          : `needs ${missing.join(", ")}`;
      console.log(`${s.id.padEnd(16)} ${s.name.padEnd(38)} ${state}`);
    }
  },

  async export() {
    process.stdout.write(toRis(await store.list()));
  },

  async stats() {
    for (const [label, value] of await stats()) console.log(`${label.padEnd(46)} ${value}`);
  },

  async verify() {
    const { errors, notes } = await verify();
    for (const n of notes) console.log(`note: ${n}`);
    for (const e of errors) console.log(`error: ${e}`);
    console.log(errors.length ? `${errors.length} invariant(s) broken` : "all invariants hold");
    if (errors.length) process.exitCode = 1;
  },
};

// verify reports a misplaced library itself; sources and find do not touch it.
const NO_GUARD = new Set(["sources", "find", "verify"]);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string", short: "f" },
    status: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [name, ...args] = positionals;

if (!name || values.help || !commands[name]) {
  console.log(HELP);
  process.exit(name && !commands[name] ? 1 : 0);
}
try {
  if (!NO_GUARD.has(name)) store.assertLibrary();
  await commands[name](args, values);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
