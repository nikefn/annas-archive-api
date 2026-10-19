/**
 * Imported first by every test that loads src/: a throwaway library and no
 * credentials, so tests never touch real data or a paid API.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LITFETCH_LIBRARY = mkdtempSync(join(tmpdir(), "litfetch-test-"));
for (const key of ["ANTHROPIC_API_KEY", "CORE_API_KEY", "ANNAS_KEY", "OPENALEX_API_KEY", "SEMANTIC_SCHOLAR_API_KEY"]) {
  process.env[key] = "";
}
