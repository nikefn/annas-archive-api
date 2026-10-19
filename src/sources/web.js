/**
 * Web pages: a URL typed by the user, or the landing page a DOI resolves to.
 * Landing pages supply metadata and the PDF link through citation_* meta tags,
 * the convention most journals and repositories follow. For DOIs of a few large
 * publishers the PDF URL also follows from the DOI itself.
 *
 * Nothing here signs in or gets past a bot check: a refused or challenged page
 * yields no file. A server that is down is an outage like for any source.
 */

import { load } from "cheerio";

import { config } from "../config.js";
import { HttpError, client, isOutage } from "../http.js";
import { bareDoi, yearOf } from "./meta.js";

const http = client();

/** DOI prefix -> PDF URL. Only publishers whose PDF URL needs nothing but the DOI. */
const PUBLISHER_PDF = [
  ["10.1007/", "https://link.springer.com/content/pdf/{doi}.pdf"],
  ["10.1002/", "https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}"],
  ["10.1111/", "https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}"],
  ["10.1080/", "https://www.tandfonline.com/doi/pdf/{doi}"],
  ["10.1177/", "https://journals.sagepub.com/doi/pdf/{doi}"],
];

export const publisherPdf = (doi) =>
  PUBLISHER_PDF.filter(([prefix]) => doi?.startsWith(prefix)).map(([, t]) => t.replace("{doi}", doi));

/** Metadata and PDF links from a landing page's citation_* meta tags. */
export function parseLandingPage(html, pageUrl) {
  const $ = load(html);
  const tag = (name) => $(`meta[name="${name}"]`).map((_, el) => $(el).attr("content")?.trim()).get().filter(Boolean);
  return {
    meta: {
      title: tag("citation_title")[0] || tag("dc.title")[0],
      authors: tag("citation_author").length ? tag("citation_author") : tag("dc.creator"),
      year: yearOf(tag("citation_publication_date")[0] || tag("citation_date")[0] || tag("dc.date")[0]),
      doi: bareDoi(tag("citation_doi")[0]),
      isbn: tag("citation_isbn"),
      venue: tag("citation_journal_title")[0],
      publisher: tag("citation_publisher")[0],
      language: tag("citation_language")[0],
    },
    files: tag("citation_pdf_url").map((u) => ({ url: new URL(u, pageUrl).toString() })),
  };
}

/** The page at `url`: { html: false } for a non-HTML response, null when refused or challenged. */
async function fetchPage(url) {
  try {
    const resp = await http.request(url, { redirect: "follow", totalMs: config.timeoutMs });
    if (!resp.ok) {
      await resp.body?.cancel();
      if (resp.status === 429 || resp.status >= 500) throw new HttpError(`HTTP ${resp.status}`, resp.status);
      return null;
    }
    if (!(resp.headers.get("content-type") || "").includes("html")) {
      await resp.body?.cancel();
      return { html: false };
    }
    return { html: true, ...parseLandingPage(await resp.text(), resp.url) };
  } catch (err) {
    if (isOutage(err) && err.code !== "CHALLENGE") throw err;
    return null;
  }
}

export default {
  id: "web",
  name: "Web pages (URL or DOI landing page)",
  missing: () => [],

  async find(q) {
    const url = q.url ?? (q.doi ? `https://doi.org/${q.doi}` : null);
    if (!url) return [];
    const page = await fetchPage(url);
    const files = [
      ...(page?.html ? page.files : q.url ? [{ url: q.url }] : []),
      ...publisherPdf(q.doi).map((u) => ({ url: u })),
    ];
    if (!files.length && !page?.html) return [];
    return [{ meta: { ...page?.meta, url: q.url, doi: q.doi ?? page?.meta?.doi }, files }];
  },
};
