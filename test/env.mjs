/**
 * Imported first by every test that loads src/: a throwaway library, no keys,
 * no pacing for the local test servers, and no network beyond this machine.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LITFETCH_LIBRARY = mkdtempSync(join(tmpdir(), "litfetch-test-"));
process.env.LITFETCH_PACE = "127.0.0.1=0";
for (const key of ["ANTHROPIC_API_KEY", "CORE_API_KEY", "OPENALEX_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "LITFETCH_LLM_MODELS"]) {
  process.env[key] = "";
}
process.env.ANNAS_KEY ??= "";

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const host = new URL(input instanceof Request ? input.url : input).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`test tried to reach ${host}; tests must stay offline`);
    process.exit(1);
  }
  return realFetch(input, init);
};
