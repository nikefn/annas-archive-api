/**
 * Zenodo: CERN's open repository — reports, project deliverables, preprints,
 * posters and datasets. Keyless; 30 requests per minute. Files carry md5 sums.
 */

import { client } from "../http.js";
import { bareDoi, searchTerms, yearOf } from "./meta.js";

const API = "https://zenodo.org/api/records";
const DOCUMENT = /\.(pdf|epub|djvu)$/i;
const http = client({ minIntervalMs: 2100 });

export function toCandidate(r) {
  const m = r.metadata ?? {};
  return {
    meta: {
      title: m.title,
      authors: (m.creators ?? []).map((c) => c.name).filter(Boolean),
      year: yearOf(m.publication_date),
      doi: bareDoi(r.doi ?? m.doi),
      type: m.resource_type?.subtype ?? m.resource_type?.type ?? m.resource_type?.id,
      publisher: "Zenodo",
      language: m.language,
      url: r.links?.self_html ?? r.links?.html,
    },
    files: (r.files ?? [])
      .filter((f) => DOCUMENT.test(f.key))
      .map((f) => ({
        url: f.links?.self,
        md5: String(f.checksum ?? "").startsWith("md5:") ? f.checksum.slice(4) : undefined,
        license: m.license?.id,
      })),
  };
}

export default {
  id: "zenodo",
  name: "Zenodo",
  missing: () => [],

  async find(q) {
    let query;
    if (q.doi) query = `doi:"${q.doi}"`;
    else if (q.title) query = `title:"${searchTerms(q.title)}"`;
    else return [];
    const data = await http.json(`${API}?${new URLSearchParams({ q: query, size: "5" })}`);
    return (data.hits?.hits ?? []).map(toCandidate);
  },
};
