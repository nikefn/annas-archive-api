/**
 * Semantic Scholar: broad scholarly graph with open-access PDF links. Works
 * without a key on a shared, heavily throttled pool; a key raises the limit.
 */

import { config } from "../config.js";
import { client } from "../http.js";
import { bareDoi } from "./meta.js";

const API = "https://api.semanticscholar.org/graph/v1/paper";
const FIELDS = "title,authors,year,externalIds,openAccessPdf,venue,publicationTypes";
const http = client({
  minIntervalMs: 1100,
  headers: config.keys.semanticscholar ? { "x-api-key": config.keys.semanticscholar } : {},
});

export function toCandidate(p) {
  const ids = p.externalIds ?? {};
  return {
    meta: {
      title: p.title,
      authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
      year: p.year ?? undefined,
      doi: bareDoi(ids.DOI),
      arxiv: ids.ArXiv,
      pmid: ids.PubMed,
      pmcid: ids.PubMedCentral ? `PMC${ids.PubMedCentral}` : undefined,
      type: p.publicationTypes?.[0],
      venue: p.venue || undefined,
    },
    files: p.openAccessPdf?.url ? [{ url: p.openAccessPdf.url, license: p.openAccessPdf.license }] : [],
  };
}

export default {
  id: "semanticscholar",
  name: "Semantic Scholar",
  missing: () => [],

  async find(q) {
    const id = q.doi ? `DOI:${q.doi}` : q.arxiv ? `ARXIV:${q.arxiv}` : q.pmid ? `PMID:${q.pmid}` : null;
    if (id) {
      const p = await http.lookup(`${API}/${encodeURIComponent(id)}?fields=${FIELDS}`);
      return p ? [toCandidate(p)] : [];
    }
    if (!q.title) return [];
    const params = new URLSearchParams({ query: q.title, fields: FIELDS });
    const data = await http.lookup(`${API}/search/match?${params}`);
    return (data?.data ?? []).map(toCandidate);
  },
};
