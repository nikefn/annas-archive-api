/**
 * arXiv: preprints in physics, mathematics, computer science and neighbours.
 * The API asks for no more than one request every three seconds.
 */

import { load } from "cheerio";

import { client } from "../http.js";
import { bareDoi, searchTerms, yearOf } from "./meta.js";

const API = "https://export.arxiv.org/api/query";
const http = client();

/** Parse an arXiv Atom feed into candidates. */
export function parseFeed(xml) {
  const $ = load(xml, { xmlMode: true });
  return $("entry")
    .map((_, el) => {
      const e = $(el);
      const absUrl = e.children("id").text().trim();
      const id = absUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
      if (!id || absUrl.includes("api/errors")) return null;
      return {
        meta: {
          title: e.children("title").text().replace(/\s+/g, " ").trim(),
          authors: e.find("author > name").map((__, n) => $(n).text().trim()).get(),
          year: yearOf(e.children("published").text()),
          arxiv: id,
          doi: bareDoi(e.children("arxiv\\:doi").text().trim() || undefined),
          type: "preprint",
        },
        files: [{ url: `https://arxiv.org/pdf/${id}`, version: "submittedVersion", format: "pdf" }],
      };
    })
    .get()
    .filter(Boolean);
}

export default {
  id: "arxiv",
  name: "arXiv",
  missing: () => [],

  async find(q) {
    const params = new URLSearchParams({ max_results: "5" });
    if (q.arxiv) params.set("id_list", q.arxiv);
    else if (q.title) params.set("search_query", `ti:"${searchTerms(q.title)}"`);
    else return [];
    return parseFeed(await http.text(`${API}?${params}`));
  },
};
