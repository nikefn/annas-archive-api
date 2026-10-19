/**
 * Every setting litfetch reads, in one place. Values come from the environment
 * and from `.env` in the working directory. Nothing else reads process.env.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  // No .env file: environment variables alone are fine.
}

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const num = (name, fallback) => (env(name) === "" ? fallback : Number(env(name)));
const list = (name, fallback = "") =>
  env(name, fallback).split(",").map((s) => s.trim()).filter(Boolean);

/** Open sources, tried in this order. Rate-limited and shadow-library sources are opt-in. */
const DEFAULT_SOURCES =
  "web,crossref,openalex,unpaywall,arxiv,europepmc,semanticscholar,core,hal,zenodo,worldbank,dspace,unods,cellar";

const email = env("LITFETCH_EMAIL");
const coreKey = env("CORE_API_KEY");

/**
 * Minimum milliseconds between request starts to one host, for API calls and
 * downloads alike. The first entry whose text occurs in the hostname applies.
 * LITFETCH_PACE ("host=ms,host=ms") entries take precedence.
 */
const PACE = [
  ...list("LITFETCH_PACE").map((entry) => {
    const [host, ms] = entry.split("=");
    return [host.trim(), Number(ms)];
  }),
  ["arxiv.org", 3000],
  ["libgen.", 2000],
  ["annas-archive.", 1500],
  ["semanticscholar.org", 1100],
  ["api.crossref.org", email ? 350 : 1000],
  ["core.ac.uk", coreKey ? 1000 : 2000],
  ["zenodo.org", 2100],
  ["openaire.eu", 60_000],
  ["api.openalex.org", 100],
  ["api.unpaywall.org", 100],
  ["ebi.ac.uk", 200],
  ["archives-ouvertes.fr", 500],
  ["worldbank.org", 500],
];
const DEFAULT_PACE_MS = 1000;

export const config = {
  library: resolve(env("LITFETCH_LIBRARY", join(homedir(), "litfetch-library"))),
  email,
  sources: list("LITFETCH_SOURCES", DEFAULT_SOURCES),
  concurrency: num("LITFETCH_CONCURRENCY", 4),
  maxAttempts: num("LITFETCH_MAX_ATTEMPTS", 5),
  maxBytes: num("LITFETCH_MAX_MB", 600) * 1024 * 1024,
  timeoutMs: num("LITFETCH_TIMEOUT_S", 30) * 1000,
  outageRetryHours: num("LITFETCH_OUTAGE_RETRY_H", 6),
  llmModels: list("LITFETCH_LLM_MODELS"),

  paceOf: (host) => PACE.find(([part]) => host.includes(part))?.[1] ?? DEFAULT_PACE_MS,

  keys: {
    anthropic: env("ANTHROPIC_API_KEY"),
    openalex: env("OPENALEX_API_KEY"),
    semanticscholar: env("SEMANTIC_SCHOLAR_API_KEY"),
    core: coreKey,
    annas: env("ANNAS_KEY"),
  },

  dspaceRepositories: list(
    "DSPACE_REPOSITORIES",
    "https://iris.who.int,https://openknowledge.worldbank.org,https://openknowledge.fao.org"
  ),
  annasMirrors: list("ANNAS_MIRRORS", "https://annas-archive.gl,https://annas-archive.pk,https://annas-archive.gd"),
  annasWindowHours: num("ANNAS_WINDOW_H", 18),
  annasMaxPerWork: num("ANNAS_MAX_PER_WORK", 2),
  ipfsGateways: list("IPFS_GATEWAYS", "https://ipfs.io,https://dweb.link"),
  libgenMirrors: list("LIBGEN_MIRRORS", "https://libgen.li,https://libgen.vg,https://libgen.gl,https://libgen.bz,https://libgen.la"),

  ui: {
    host: env("LITFETCH_UI_HOST", "127.0.0.1"),
    port: num("LITFETCH_UI_PORT", 3000),
    token: env("LITFETCH_UI_TOKEN"),
  },
};
