/**
 * A URL typed by the user. If it points at a landing page, the page's
 * citation_* meta tags (the Highwire/Google Scholar convention used by most
 * repositories, journals and document servers) supply metadata and the PDF link.
 */

import { load } from "cheerio";

import { client } from "../http.js";
import { bareDoi, yearOf } from "./meta.js";

const http = client({ minIntervalMs: 1000 });

/** Metadata and PDF link from a landing page's citation_* meta tags. */
export function parseLandingPage(html, pageUrl) {
  const $ = load(html);
  const tag = (name) => $(`meta[name="${name}"]`).map((_, el) => $(el).attr("content")?.trim()).get().filter(Boolean);
  const pdfs = tag("citation_pdf_url").map((u) => new URL(u, pageUrl).toString());
  return {
    meta: {
      url: pageUrl,
      title: tag("citation_title")[0] || tag("dc.title")[0],
      authors: tag("citation_author").length ? tag("citation_author") : tag("dc.creator"),
      year: yearOf(tag("citation_publication_date")[0] || tag("citation_date")[0] || tag("dc.date")[0]),
      doi: bareDoi(tag("citation_doi")[0]),
      isbn: tag("citation_isbn"),
      venue: tag("citation_journal_title")[0],
      publisher: tag("citation_publisher")[0],
      language: tag("citation_language")[0],
    },
    files: pdfs.map((url) => ({ url })),
  };
}

export default {
  id: "url",
  name: "Direct URL",
  missing: () => [],

  async find(q) {
    if (!q.url) return [];
    const resp = await http.request(q.url, { redirect: "follow" });
    const type = resp.headers.get("content-type") || "";
    if (!resp.ok || !type.includes("html")) {
      await resp.body?.cancel();
      return [{ meta: { url: q.url }, files: [{ url: q.url }] }];
    }
    const page = parseLandingPage(await resp.text(), resp.url);
    page.meta.url = q.url;
    return [page];
  },
};
