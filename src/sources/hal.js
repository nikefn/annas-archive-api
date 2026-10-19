/**
 * HAL: French national open archive of articles, theses, research reports and
 * working papers from French universities and research bodies. Keyless.
 */

import { client } from "../http.js";
import { bareDoi, searchTerms } from "./meta.js";

const API = "https://api.archives-ouvertes.fr/search/";
const FIELDS = "halId_s,title_s,authFullName_s,producedDateY_i,doiId_s,isbn_s,docType_s,language_s,fileMain_s,uri_s";
const http = client();

export function toCandidate(d) {
  return {
    meta: {
      title: d.title_s?.[0],
      authors: d.authFullName_s ?? [],
      year: d.producedDateY_i,
      doi: bareDoi(d.doiId_s),
      isbn: [].concat(d.isbn_s ?? []),
      type: d.docType_s,
      language: d.language_s?.[0],
      url: d.uri_s,
    },
    files: d.fileMain_s ? [{ url: d.fileMain_s }] : [],
  };
}

export default {
  id: "hal",
  name: "HAL",
  missing: () => [],

  async find(q) {
    let query;
    if (q.doi) query = `doiId_s:"${q.doi}"`;
    else if (q.title) query = `title_t:"${searchTerms(q.title)}"`;
    else return [];
    const params = new URLSearchParams({ q: query, fl: FIELDS, rows: "5", wt: "json" });
    const data = await http.json(`${API}?${params}`);
    return (data.response?.docs ?? []).map(toCandidate);
  },
};
