/**
 * Imported first by every test that loads src/. It runs each test file in an
 * empty temporary folder (so no .env is read), clears every litfetch setting
 * from the environment, points the library there, turns off pacing for the
 * local test servers, and ends the process if code calls fetch() for any host
 * other than this machine. The folder is removed when the process exits.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "litfetch-test-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.chdir(root);

/** A new empty folder inside this test file's temporary folder. */
export const scratch = (prefix) => mkdtempSync(join(root, `${prefix}-`));

const SETTINGS = /^(LITFETCH_|ANNAS_|IPFS_|LIBGEN_|DSPACE_|OPENALEX_|SEMANTIC_SCHOLAR_|CORE_|ANTHROPIC_)/;
for (const name of Object.keys(process.env)) if (SETTINGS.test(name)) delete process.env[name];
process.env.LITFETCH_LIBRARY = join(root, "library");
process.env.LITFETCH_PACE = "127.0.0.1=0";

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const host = new URL(input instanceof Request ? input.url : input).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`test tried to reach ${host}; tests must stay offline`);
    process.exit(1);
  }
  return realFetch(input, init);
};
