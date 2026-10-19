/**
 * World Bank Documents & Reports: analytical reports, working papers, project
 * and policy documents. Keyless JSON search with direct PDF links.
 */

import { client } from "../http.js";
import { searchTerms, yearOf } from "./meta.js";

const API = "https://search.worldbank.org/api/v3/wds";
const FIELDS = "id,display_title,docdt,pdfurl,docty,authors,lang,repnb";
const http = client({ minIntervalMs: 500 });

export function parseResponse(data) {
  return Object.values(data.documents ?? {})
    .filter((d) => d && d.id && d.display_title)
    .map((d) => ({
      meta: {
        title: d.display_title.trim(),
        authors: Object.values(d.authors ?? {}).map((a) => a.author).filter(Boolean),
        year: yearOf(d.docdt),
        type: d.docty,
        publisher: "World Bank",
        language: d.lang,
      },
      files: d.pdfurl ? [{ url: d.pdfurl }] : [],
    }));
}

export default {
  id: "worldbank",
  name: "World Bank Documents & Reports",
  missing: () => [],

  async find(q) {
    if (!q.title) return [];
    const params = new URLSearchParams({ format: "json", qterm: searchTerms(q.title), fl: FIELDS, rows: "5" });
    return parseResponse(await http.json(`${API}?${params}`));
  },
};
