/**
 * Open Library: book metadata by ISBN or title (keyless), and full scans from
 * the Internet Archive for books in the public domain. Its ISBN lists are what
 * lets an ISBN-only work match title search results from other sources.
 */

import { client } from "../http.js";
import { searchTerms } from "./meta.js";

const API = "https://openlibrary.org/search.json";
const FIELDS = "title,subtitle,author_name,first_publish_year,isbn,number_of_pages_median,ebook_access,ia,language";
const http = client();

export function toCandidate(d) {
  const scans = d.ebook_access === "public" ? (d.ia ?? []).slice(0, 2) : [];
  return {
    meta: {
      title: [d.title, d.subtitle].filter(Boolean).join(": ") || undefined,
      authors: d.author_name ?? [],
      year: d.first_publish_year ?? undefined,
      isbn: d.isbn ?? [],
      type: "book",
      language: d.language?.[0],
      pages: d.number_of_pages_median ?? undefined,
    },
    files: scans.map((id) => ({ url: `https://archive.org/download/${id}/${id}.pdf`, license: "public domain" })),
  };
}

export default {
  id: "openlibrary",
  name: "Open Library",
  missing: () => [],

  async find(q) {
    const params = new URLSearchParams({ fields: FIELDS, limit: "5" });
    if (q.isbn) params.set("isbn", q.isbn);
    else if (q.title && !q.doi && !q.arxiv) params.set("title", searchTerms(q.title));
    else return [];
    const data = await http.json(`${API}?${params}`);
    return (data.docs ?? []).map(toCandidate);
  },
};
