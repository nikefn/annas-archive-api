/**
 * OpenAlex: open index of ~250M scholarly works with open-access locations
 * (Unpaywall data built in), retraction flags and page ranges. Needs a free API
 * key; single-record lookups cost nothing, searches draw on its daily budget.
 */

import { config } from "../config.js";
import { client } from "../http.js";
import { bareDoi, pageCount, searchTerms } from "./meta.js";

const API = "https://api.openalex.org/works";
const http = client();

export function toCandidate(w) {
  const locations = [w.best_oa_location, ...(w.locations ?? [])].filter((l) => l?.pdf_url);
  return {
    meta: {
      title: w.display_name ?? w.title,
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? a.raw_author_name).filter(Boolean),
      year: w.publication_year ?? undefined,
      doi: bareDoi(w.doi),
      pmid: w.ids?.pmid?.replace(/\D+/g, "") || undefined,
      pmcid: w.ids?.pmcid?.match(/PMC\d+/)?.[0],
      type: w.type,
      venue: w.primary_location?.source?.display_name,
      language: w.language,
      pages: pageCount(w.biblio?.first_page, w.biblio?.last_page),
      retracted: w.is_retracted || undefined,
    },
    files: locations.map((l) => ({ url: l.pdf_url, version: l.version, license: l.license })),
  };
}

export default {
  id: "openalex",
  name: "OpenAlex",
  missing: () => (config.keys.openalex ? [] : ["OPENALEX_API_KEY"]),

  async find(q) {
    const params = new URLSearchParams({ api_key: config.keys.openalex });
    const id = q.doi ? `doi:${q.doi}` : q.pmid ? `pmid:${q.pmid}` : q.pmcid ? `pmcid:${q.pmcid}` : null;
    if (id) {
      const w = await http.lookup(`${API}/${id}?${params}`);
      return w ? [toCandidate(w)] : [];
    }
    if (!q.title) return [];
    params.set("search", searchTerms(q.title));
    params.set("per_page", "5");
    const data = await http.json(`${API}?${params}`);
    return (data.results ?? []).map(toCandidate);
  },
};
