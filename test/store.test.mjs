import { scratch } from "./env.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { config } from "../src/config.js";
import * as store from "../src/store.js";

test("a library inside a git checkout must be git-ignored", () => {
  const repo = scratch("repo");
  execFileSync("git", ["init", "-q", repo]);
  assert.match(store.libraryProblem(join(repo, "tmp-lib")), /inside the git checkout/);
  writeFileSync(join(repo, ".gitignore"), "tmp-lib/\n");
  assert.equal(store.libraryProblem(join(repo, "tmp-lib")), null);
  assert.equal(store.libraryProblem(scratch("free")), null);
});

test("stray files and unreadable records in works/ do not break listing", async () => {
  await store.add("10.5555/listed");
  mkdirSync(join(config.library, "works", "empty-folder"), { recursive: true });
  writeFileSync(join(config.library, "works", ".DS_Store"), "x");
  const { works, broken } = await store.scan();
  assert.ok(works.some((w) => w.id === "doi-10.5555-listed"));
  assert.deepEqual(broken, ["empty-folder"]);
});

test("identifiers whose folder names would collide get separate works", async () => {
  const a = await store.add("10.5555/a_b");
  const b = await store.add("10.5555/a-b");
  assert.ok(a.created && b.created);
  assert.notEqual(a.work.id, b.work.id);
  assert.equal((await store.add("10.5555/a-b")).created, false);
});

test("the library lock admits one command at a time and outlives no process", async () => {
  const release = await store.lock();
  writeFileSync(join(config.library, ".lock"), "999999999"); // a pid that is not running
  const again = await store.lock();
  await again();
  await release();
  writeFileSync(join(config.library, ".lock"), String(process.ppid));
  await assert.rejects(store.lock(), /another litfetch command/);
});

test("index.csv cells cannot run as spreadsheet formulas", async () => {
  const { work } = await store.add("=HYPERLINK(1)");
  await store.writeIndex();
  const csv = readFileSync(join(config.library, "index.csv"), "utf8");
  assert.ok(csv.includes("'=HYPERLINK(1)"));
  assert.ok(work);
});
