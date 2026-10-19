/**
 * Source registry. A source is a module whose default export is:
 *
 *   id        short name used in LITFETCH_SOURCES and in work records
 *   name      human-readable name
 *   missing() names of settings it still needs (empty array = ready)
 *   find(q)   -> Promise<Candidate[]> for a query { doi, arxiv, isbn, title, … }
 *   resolve?  (file) -> Promise<{ url, headers?, md5? }>, only for files whose
 *             link must be looked up or signed right before download
 *
 *   Candidate = { meta: Meta, files: [File] }
 *   File      = { url?, headers?, md5?, format?, version?, license? } — md5, when
 *               known, is verified after download; other keys are for resolve()
 *   Meta      = { title, authors: ["Family, Given" | "Given Family"], year, doi,
 *                 isbn: [], arxiv, pmid, pmcid, md5, celex, symbol, type, venue, publisher,
 *                 language, pages, retracted, url }   (all optional)
 *
 * A source returns [] when the query has nothing it can search by. Setup for
 * each source is documented in docs/sources.md.
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
import semanticscholar from "./semanticscholar.js";
import unods from "./unods.js";
import unpaywall from "./unpaywall.js";
import url from "./url.js";
import worldbank from "./worldbank.js";
import zenodo from "./zenodo.js";

export const SOURCES = Object.fromEntries(
  [url, crossref, openalex, unpaywall, arxiv, europepmc, semanticscholar, core, hal, zenodo,
    worldbank, dspace, unods, cellar, openaire, annas, libgen].map((s) => [s.id, s])
);

/** Sources listed in LITFETCH_SOURCES that have everything they need, in that order. */
export function activeSources() {
  return config.sources.map((id) => SOURCES[id]).filter((s) => s && !s.missing().length);
}
