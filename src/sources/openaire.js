/**
 * OpenAIRE Graph: Europe's research graph of publications, EU project reports
 * and deliverables linked to CORDIS projects, across thousands of repositories.
 * Anonymous use is limited to 60 requests per hour, so it is opt-in.
 */

import { client } from "../http.js";
import { bareDoi, searchTerms, yearOf } from "./meta.js";

const API = "https://api.openaire.eu/graph/v3/research-products";
const http = client();

export function toCandidate(r) {
  const open = (r.instances ?? []).filter((i) => /open/i.test(i.accessRight?.label ?? i.accessRight?.code ?? ""));
  return {
    meta: {
      title: r.mainTitle,
      authors: (r.authors ?? []).map((a) => a.fullName).filter(Boolean),
      year: yearOf(r.publicationDate),
      doi: bareDoi(r.pids?.find((p) => p.scheme === "doi")?.value),
      type: r.instances?.[0]?.type ?? r.type,
      publisher: r.publisher,
      language: r.language?.code,
    },
    files: open.flatMap((i) => i.urls ?? []).map((url) => ({ url })),
  };
}

export default {
  id: "openaire",
  name: "OpenAIRE Graph",
  missing: () => [],

  async find(q) {
    const params = new URLSearchParams({ pageSize: "5" });
    if (q.doi) params.set("pid", q.doi);
    else if (q.title) params.set("search", searchTerms(q.title));
    else return [];
    const data = await http.json(`${API}?${params}`);
    return (data.results ?? []).map(toCandidate);
  },
};
