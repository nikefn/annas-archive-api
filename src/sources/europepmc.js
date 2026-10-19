/**
 * Europe PMC: life-science literature (PubMed, PMC, preprints, patents,
 * guidelines). Open-access PMC articles come with a PDF link.
 */

import { client } from "../http.js";
import { bareDoi, pageCount, searchTerms, yearOf } from "./meta.js";

const API = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const http = client({ minIntervalMs: 200 });

export function toCandidate(r) {
  const urls = r.fullTextUrlList?.fullTextUrl ?? [];
  return {
    meta: {
      title: r.title?.replace(/\.$/, ""),
      authors: (r.authorList?.author ?? []).map((a) => a.fullName ?? a.collectiveName).filter(Boolean),
      year: yearOf(r.pubYear),
      doi: bareDoi(r.doi),
      pmid: r.pmid,
      pmcid: r.pmcid,
      type: r.pubType,
      venue: r.journalInfo?.journal?.title ?? r.journalTitle,
      language: r.language,
      pages: pageCount(r.pageInfo),
    },
    files: urls
      .filter((u) => u.documentStyle === "pdf" && /open access|free/i.test(u.availability))
      .map((u) => ({ url: u.url })),
  };
}

export default {
  id: "europepmc",
  name: "Europe PMC",
  missing: () => [],

  async find(q) {
    let query;
    if (q.doi) query = `DOI:"${q.doi}"`;
    else if (q.pmcid) query = `PMCID:${q.pmcid}`;
    else if (q.pmid) query = `EXT_ID:${q.pmid} AND SRC:MED`;
    else if (q.title) query = `TITLE:"${searchTerms(q.title)}"`;
    else return [];
    const params = new URLSearchParams({ query, format: "json", resultType: "core", pageSize: "5" });
    const data = await http.json(`${API}?${params}`);
    return (data.resultList?.result ?? []).map(toCandidate);
  },
};
