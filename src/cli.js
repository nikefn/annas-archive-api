#!/usr/bin/env node
/**
 * litfetch command line. Every command reads and writes the library through
 * store.js; `run` is the only one that touches the network for files.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { checkFile } from "./checks/index.js";
import { config } from "./config.js";
import { toRis } from "./export.js";
import { parseInput } from "./ids.js";
import { gather, run } from "./pipeline.js";
import { SOURCES, activeSources } from "./sources/index.js";
import * as store from "./store.js";

const HELP = `litfetch — queue, fetch and verify literature

  add <input…> [-f list.txt]   queue works: DOI, arXiv id, ISBN, PMID/PMCID,
                               md5, CELEX, UN symbol, URL or a title/citation
  run [id…]                    process queued works (or the given ones)
  status                       counts per status; lists works to look at
  show <id>                    print one work record
  retry [id…] [--failed] [--review]
                               put works back in the queue
  recheck [id…]                re-run checks on kept files (no download)
  find <input>                 ask the sources without queueing anything
  sources                      which sources are active, what others need
  export                       RIS of the library to stdout (attaches files)

Library: ${config.library}
Settings: environment or .env — see .env.example`;

const commands = {
  async add(args, opts) {
    const lines = [...args];
    if (opts.file) lines.push(...(await readFile(opts.file, "utf8")).split("\n"));
    let added = 0;
    for (const line of lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
      const { work, created } = await store.add(line);
      added += created;
      console.log(`${created ? "queued " : "exists "} ${work.id}`);
    }
    await store.writeIndex();
    console.log(`${added} added`);
  },

  async run(ids) {
    const active = activeSources();
    console.log(`sources: ${active.map((s) => s.id).join(", ")}`);
    const done = await run({
      ids: ids.length ? ids : undefined,
      onDone: (w) => console.log(`${w.status.padEnd(7)} ${w.id}${w.error ? `  (${w.error})` : ""}`),
    });
    console.log(`${done.length} processed — see ${join(config.library, "index.csv")}`);
  },

  async status() {
    const works = await store.list();
    for (const s of store.STATUSES) console.log(`${s.padEnd(7)} ${works.filter((w) => w.status === s).length}`);
    for (const w of works.filter((w) => w.status === "review" || w.status === "failed")) {
      const why = w.error ?? w.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`).join("; ");
      console.log(`\n${w.status} ${w.id}\n  ${why}`);
    }
  },

  async show([id]) {
    const work = await store.load(id);
    if (!work) throw new Error(`no work ${id}`);
    console.log(JSON.stringify(work, null, 2));
  },

  async retry(ids, opts) {
    const works = await store.list();
    const pick = works.filter((w) =>
      ids.length ? ids.includes(w.id) : (opts.failed && w.status === "failed") || (opts.review && w.status === "review")
    );
    for (const w of pick) await store.save({ ...w, status: "queued" });
    await store.writeIndex();
    console.log(`${pick.length} requeued`);
  },

  async recheck(ids) {
    const duplicates = new Map();
    const works = (await store.list()).filter((w) => w.file);
    for (const w of works) duplicates.set(w.file.sha256, duplicates.get(w.file.sha256) ?? w.id);
    for (const w of works.filter((w) => !ids.length || ids.includes(w.id))) {
      const others = new Map([...duplicates].filter(([, id]) => id !== w.id));
      const result = await checkFile({
        path: join(store.workDir(w.id), w.file.name),
        file: w.file,
        expected: { md5: w.file.referenceMd5 },
        meta: w.meta,
        candidates: w.candidates ?? [],
        duplicates: others,
      });
      w.checks = result.checks;
      w.status = { pass: "done", warn: "review", fail: "failed" }[result.verdict];
      await store.save(w);
      console.log(`${w.status.padEnd(7)} ${w.id}`);
    }
    await store.writeIndex();
  },

  async find(args) {
    const query = parseInput(args.join(" "));
    const lookups = [];
    const candidates = await gather(query, activeSources(), lookups);
    console.log(JSON.stringify({ query, lookups, candidates }, null, 2));
  },

  async sources() {
    const active = new Set(activeSources().map((s) => s.id));
    for (const s of Object.values(SOURCES)) {
      const state = active.has(s.id)
        ? "active"
        : s.missing().length
          ? `needs ${s.missing().join(", ")}`
          : "off (not in LITFETCH_SOURCES)";
      console.log(`${s.id.padEnd(16)} ${s.name.padEnd(34)} ${state}`);
    }
  },

  async export() {
    process.stdout.write(toRis(await store.list()));
  },
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string", short: "f" },
    failed: { type: "boolean" },
    review: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const [name, ...args] = positionals;

if (!name || values.help || !commands[name]) {
  console.log(HELP);
  process.exit(name && !commands[name] ? 1 : 0);
}
try {
  await commands[name](args, values);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
