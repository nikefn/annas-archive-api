/**
 * Unpaywall: legal open-access copies for a DOI (publisher, repository,
 * preprint). Requires a contact email on every request.
 */

import { config } from "../config.js";
import { client } from "../http.js";
import { bareDoi, personName } from "./meta.js";

const API = "https://api.unpaywall.org/v2";
const http = client({ minIntervalMs: 100 });

export function toCandidate(r) {
  const locations = [r.best_oa_location, ...(r.oa_locations ?? [])].filter((l) => l?.url_for_pdf);
  return {
    meta: {
      title: r.title,
      authors: (r.z_authors ?? []).map((a) => personName(a.family, a.given) ?? a.raw_author_name).filter(Boolean),
      year: r.year ?? undefined,
      doi: bareDoi(r.doi),
      type: r.genre,
      venue: r.journal_name,
      publisher: r.publisher,
    },
    files: locations.map((l) => ({ url: l.url_for_pdf, version: l.version, license: l.license })),
  };
}

export default {
  id: "unpaywall",
  name: "Unpaywall",
  missing: () => (config.email ? [] : ["LITFETCH_EMAIL"]),

  async find(q) {
    if (!q.doi) return [];
    const data = await http.lookup(`${API}/${encodeURIComponent(q.doi)}?email=${encodeURIComponent(config.email)}`);
    return data ? [toCandidate(data)] : [];
  },
};
