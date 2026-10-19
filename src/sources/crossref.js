/**
 * Crossref: the registration agency for most DOIs. Authoritative metadata,
 * retraction notices (incl. Retraction Watch data) and, for openly licensed
 * works, publisher full-text links.
 */

import { config } from "../config.js";
import { client } from "../http.js";
import { bareDoi, pageCount, personName, yearOf } from "./meta.js";

const API = "https://api.crossref.org";
// Polite pool (with a contact email) allows more requests than the public one.
const http = client({ minIntervalMs: config.email ? 350 : 1000 });

export function toCandidate(m) {
  const date = m.issued?.["date-parts"]?.[0]?.[0] ?? m.published?.["date-parts"]?.[0]?.[0];
  return {
    meta: {
      title: [m.title?.[0], m.subtitle?.[0]].filter(Boolean).join(": ") || undefined,
      authors: (m.author ?? []).map((a) => personName(a.family, a.given) ?? a.name).filter(Boolean),
      year: yearOf(date),
      doi: bareDoi(m.DOI),
      isbn: m.ISBN ?? [],
      type: m.type,
      venue: m["container-title"]?.[0],
      publisher: m.publisher,
      language: m.language,
      pages: pageCount(m.page),
      retracted: (m["updated-by"] ?? []).some((u) => /retract/i.test(u.type)) || undefined,
    },
    files: (m.link ?? [])
      .filter((l) => l["content-type"] === "application/pdf")
      .filter(() => (m.license ?? []).some((l) => /creativecommons\.org/.test(l.URL)))
      .map((l) => ({ url: l.URL, version: l["content-version"], license: m.license[0].URL })),
  };
}

export default {
  id: "crossref",
  name: "Crossref",
  missing: () => [],

  async find(q) {
    const params = new URLSearchParams(config.email ? { mailto: config.email } : {});
    if (q.doi) {
      const data = await http.lookup(`${API}/works/${encodeURIComponent(q.doi)}?${params}`);
      return data ? [toCandidate(data.message)] : [];
    }
    if (!q.title) return [];
    params.set("query.bibliographic", q.title);
    params.set("rows", "5");
    const data = await http.json(`${API}/works?${params}`);
    return data.message.items.map(toCandidate);
  },
};
