/**
 * CORE: full texts aggregated from thousands of institutional and subject
 * repositories — strong for theses and reports. Works without a key at
 * 5 requests per 10 seconds; a free key raises the limit.
 */

import { config } from "../config.js";
import { client } from "../http.js";
import { bareDoi, searchTerms, yearOf } from "./meta.js";

const API = "https://api.core.ac.uk/v3/search/works";
const http = client({
  minIntervalMs: config.keys.core ? 1000 : 2000,
  headers: config.keys.core ? { Authorization: `Bearer ${config.keys.core}` } : {},
});

export function toCandidate(w) {
  return {
    meta: {
      title: w.title,
      authors: (w.authors ?? []).map((a) => a.name).filter(Boolean),
      year: w.yearPublished ?? yearOf(w.publishedDate),
      doi: bareDoi(w.doi),
      arxiv: w.arxivId ?? undefined,
      type: w.documentType ?? undefined,
      publisher: w.publisher || undefined,
      language: w.language?.code,
    },
    files: w.downloadUrl ? [{ url: w.downloadUrl }] : [],
  };
}

export default {
  id: "core",
  name: "CORE",
  missing: () => [],

  async find(q) {
    let query;
    if (q.doi) query = `doi:"${q.doi}"`;
    else if (q.arxiv) query = `arxivId:"${q.arxiv}"`;
    else if (q.title) query = `title:"${searchTerms(q.title)}"`;
    else return [];
    const data = await http.json(`${API}?${new URLSearchParams({ q: query, limit: "5" })}`);
    return (data.results ?? []).map(toCandidate);
  },
};
