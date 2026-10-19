/**
 * Source registry. A source is a module whose default export is:
 *
 *   id         short name used in LITFETCH_SOURCES and in work records
 *   name       human-readable name
 *   missing()  names of settings it still needs (empty array = ready)
 *   find(q)    Promise<Candidate[]> for a query { doi, arxiv, isbn, title, ... };
 *              [] when the query has nothing it can search by
 *   describe?  (file) => Promise<{ name?, size?, format?, contentType?, ... }>:
 *              what a file is, looked up free of charge and only for book works,
 *              when the file's turn comes
 *   links?     async generator (file, { work, shared, allowCredit }) yielding
 *              { url, headers?, md5?, credit? }, for files whose download URL is
 *              looked up, signed or spread over mirrors. Without it the file's
 *              own url is downloaded. Links are tried in order until one downloads.
 *
 *   Candidate = { meta: Meta, files: [File] }
 *   File      = { url?, headers?, md5?, format?, size?, name?, contentType?,
 *               version?, license?, credit? }
 *               md5, when known, is verified after download; credit marks files
 *               that may cost a paid download and are therefore tried last; name
 *               (original file name), size and contentType help spot excerpts.
 *               A source may add its own keys for links() (e.g. dspace, scidb, ipfs).
 *   Meta      = { title, authors: ["Family, Given" | "Given Family"], year, doi,
 *               isbn: [], arxiv, pmid, pmcid, md5, celex, symbol, type, venue,
 *               publisher, language, pages, retracted, url }   (all optional)
 *
 * Errors with isOutage() true (http.js) mean "try again later"; any other error
 * means the source has nothing usable. Setup per source: docs/sources.md.
 */

import { config } from "../config.js";
import annas from "./annas.js";
import arxiv from "./arxiv.js";
import cellar from "./cellar.js";
import core from "./core.js";
import crossref from "./crossref.js";
import dspace from "./dspace.js";
import europepmc from "./europepmc.js";
import hal from "./hal.js";
import libgen from "./libgen.js";
import openaire from "./openaire.js";
import openalex from "./openalex.js";
import openlibrary from "./openlibrary.js";
import semanticscholar from "./semanticscholar.js";
import unods from "./unods.js";
import unpaywall from "./unpaywall.js";
import web from "./web.js";
import worldbank from "./worldbank.js";
import zenodo from "./zenodo.js";

export const SOURCES = Object.fromEntries(
  [web, crossref, openalex, unpaywall, openlibrary, arxiv, europepmc, semanticscholar, core, hal, zenodo,
    worldbank, dspace, unods, cellar, openaire, annas, libgen].map((s) => [s.id, s])
);

/** Sources listed in LITFETCH_SOURCES that have everything they need, in that order. */
export function activeSources() {
  return config.sources.map((id) => SOURCES[id]).filter((s) => s && !s.missing().length);
}
