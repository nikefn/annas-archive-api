/**
 * Every setting litfetch reads, in one place. Values come from the environment
 * (and `.env` in the working directory, if present). Nothing else in the
 * codebase reads process.env.
 */

import { resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  // No .env file — environment variables alone are fine.
}

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const num = (name, fallback) => Number(env(name)) || fallback;
const list = (name, fallback) =>
  env(name, fallback).split(",").map((s) => s.trim()).filter(Boolean);

/** Open sources, tried in this order. Rate-limited and shadow-library sources are opt-in. */
const DEFAULT_SOURCES =
  "url,crossref,openalex,unpaywall,arxiv,europepmc,semanticscholar,core,hal,zenodo,worldbank,dspace,unods,cellar";

export const config = {
  library: resolve(env("LITFETCH_LIBRARY", "library")),
  email: env("LITFETCH_EMAIL"),
  sources: list("LITFETCH_SOURCES", DEFAULT_SOURCES),
  concurrency: num("LITFETCH_CONCURRENCY", 4),
  maxAttempts: num("LITFETCH_MAX_ATTEMPTS", 5),
  maxBytes: num("LITFETCH_MAX_MB", 200) * 1024 * 1024,
  timeoutMs: num("LITFETCH_TIMEOUT_S", 60) * 1000,
  llmModels: list("LITFETCH_LLM_MODELS", "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5"),

  keys: {
    anthropic: env("ANTHROPIC_API_KEY"),
    openalex: env("OPENALEX_API_KEY"),
    semanticscholar: env("SEMANTIC_SCHOLAR_API_KEY"),
    core: env("CORE_API_KEY"),
    annas: env("ANNAS_KEY"),
  },

  dspaceRepositories: list(
    "DSPACE_REPOSITORIES",
    "https://iris.who.int,https://openknowledge.worldbank.org,https://openknowledge.fao.org"
  ),
  annasBaseUrl: env("ANNAS_BASE_URL", "https://annas-archive.gd"),
  libgenMirrors: list("LIBGEN_MIRRORS", "https://libgen.li,https://libgen.vg,https://libgen.gl,https://libgen.bz,https://libgen.la"),
};
