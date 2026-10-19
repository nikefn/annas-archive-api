import "./env.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { libraryProblem } from "../src/store.js";

test("a library inside a git checkout must be git-ignored", () => {
  const repo = mkdtempSync(join(tmpdir(), "litfetch-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  assert.match(libraryProblem(join(repo, "tmp-lib")), /inside the git checkout/);
  writeFileSync(join(repo, ".gitignore"), "tmp-lib/\n");
  assert.equal(libraryProblem(join(repo, "tmp-lib")), null);
  assert.equal(libraryProblem(mkdtempSync(join(tmpdir(), "litfetch-free-"))), null);
});
