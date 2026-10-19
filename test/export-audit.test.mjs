import { scratch } from "./env.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { verify } from "../src/audit.js";
import { toRis } from "../src/export.js";
import * as store from "../src/store.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("RIS: one SN line per ISBN, typed or found", () => {
  const ris = toRis([
    { id: "isbn-9780306406157", status: "queued", query: {}, meta: { title: "T", isbn: "9780306406157", type: "book" } },
  ]);
  assert.deepEqual(ris.split("\n").filter((l) => l.startsWith("SN")), ["SN  - 9780306406157"]);
  assert.match(ris, /^TY {2}- BOOK/);
});

test("verify finds a changed file and a stored key", async () => {
  const { work } = await store.add("10.5555/verify");
  writeFileSync(join(store.workDir(work.id), "f.pdf"), "content");
  await store.save({ ...work, file: { name: "f.pdf", sha256: "0".repeat(64) }, attempts: [{ url: "https://x.example/a?key=secret" }] });
  const { errors } = await verify();
  assert.ok(errors.some((e) => /file changed/.test(e)));
  assert.ok(errors.some((e) => /contains a key/.test(e)));
});

test("a mistyped number in the settings stops the program with its name", () => {
  const run = (env) =>
    execFileSync(process.execPath, [CLI, "status"], { cwd: scratch("cli"), env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: "pipe" });
  assert.throws(() => run({ LITFETCH_LIBRARY: scratch("lib"), LITFETCH_CONCURRENCY: "four" }), /LITFETCH_CONCURRENCY must be a number/);
  assert.match(run({ LITFETCH_LIBRARY: scratch("lib") }), /queued\s+0/);
});

test("retry and close refuse unknown works", () => {
  const env = { PATH: process.env.PATH, LITFETCH_LIBRARY: scratch("lib") };
  assert.throws(() => execFileSync(process.execPath, [CLI, "close", "no-such-work"], { cwd: scratch("cli"), env, stdio: "pipe" }), /no such work/);
  assert.throws(() => execFileSync(process.execPath, [CLI, "retry"], { cwd: scratch("cli"), env, stdio: "pipe" }), /name the works/);
});
