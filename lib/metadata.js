/**
 * Anna's Archive record metadata → plain object → human-readable .txt.
 * Pure, no network: lib/annas.js fetchMetadata does the fetching.
 *
 * Two sources, same output shape:
 *  - parseRecordJson: the structured record (/db/aarecord_elasticsearch/…json),
 *    whose `file_unified_data` holds the merged "best" value per field.
 *  - parseRecordPage: the /md5/<hash> HTML page, for when the JSON isn't served.
 */

import { load } from "cheerio";

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** First non-empty value; arrays contribute their first non-empty entry. */
function first(...values) {
  for (const v of values) {
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (item != null && clean(item) !== "") return clean(item);
    }
  }
  return "";
}

/**
 * Identifiers worth showing a reader, with their labels. The record also
 * carries Anna's Archive internals (aacid, filepath, server_path, ipfs_cid,
 * per-library ids, hashes) that only add noise to a book's notes.
 */
const USEFUL_IDENTIFIERS = {
  isbn13: "ISBN-13",
  isbn10: "ISBN-10",
  doi: "DOI",
  issn: "ISSN",
  asin: "ASIN",
  oclc: "OCLC",
  ol: "Open Library",
  goodreads: "Goodreads",
  google_books: "Google Books",
  lccn: "LCCN",
};

const CONTENT_TYPES = {
  book_nonfiction: "Book (non-fiction)",
  book_fiction: "Book (fiction)",
  book_unknown: "Book",
  book_comic: "Comic book",
  magazine: "Magazine",
  journal_article: "Journal article",
  standards_document: "Standards document",
};

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(clean).filter(Boolean);
const unique = (values) => [...new Set(values)];

export function formatBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Parse an aarecord JSON (either the record itself or wrapped in `_source`). */
export function parseRecordJson(json) {
  const record = json?._source ?? json ?? {};
  const f = record.file_unified_data ?? {};
  const top = record.additional?.top_box ?? {};
  const ids = f.identifiers_unified ?? {};

  const identifiers = {};
  for (const name of Object.keys(USEFUL_IDENTIFIERS)) {
    const vals = unique(list(ids[name]));
    if (vals.length) identifiers[name] = vals;
  }
  const contentType = first(f.content_type_best, f.content_type);
  const originalName = first(f.original_filename_best);

  return {
    title: first(f.title_best, top.title, f.title_additional),
    authors: first(f.author_best, top.author, f.author_additional),
    publisher: first(f.publisher_best, top.publisher_and_edition, f.publisher_additional),
    edition: first(f.edition_varia_best, f.edition_varia_additional),
    year: first(f.year_best, f.year_additional),
    language: unique(list(f.language_codes)).join(", "),
    format: first(f.extension_best).toUpperCase(),
    size: formatBytes(f.filesize_best),
    content_type: CONTENT_TYPES[contentType] ?? contentType.replace(/_/g, " "),
    original_filename: originalName.split("/").pop(),
    identifiers,
    description: first(f.stripped_description_best, top.description, f.stripped_description_additional),
  };
}

/** Parse the /md5/<hash> page. Used when the JSON record isn't available. */
export function parseRecordPage(html) {
  const $ = load(html);
  const meta = (sel) => clean($(sel).attr("content"));
  const byIcon = (icon) => clean($(`span[class*='icon-[mdi--${icon}]']`).first().closest("a, div").text());

  const identifiers = {};
  const add = (name, value) => {
    if (!value) return;
    identifiers[name] = unique([...(identifiers[name] ?? []), value]);
  };
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const isbn = href.match(/^\/isbndb\/([0-9Xx-]{10,17})$/)?.[1];
    if (isbn) add(isbn.replace(/-/g, "").length === 13 ? "isbn13" : "isbn10", isbn);
    const doi = href.match(/^\/scidb\/(10\.[^?#]+)$/)?.[1];
    if (doi) add("doi", decodeURIComponent(doi));
  });

  // "English [en] · PDF · 5.2MB · 2014 · 📘 Book (non-fiction) · …"
  let metaLine = "";
  $("div").each((_, el) => {
    const text = clean($(el).text());
    if (!metaLine && $(el).children("div").length === 0 && text.includes("·") && /\d(\.\d+)?\s?[KMG]B/.test(text)) {
      metaLine = text;
    }
  });
  const parts = metaLine.split("·").map(clean);
  const format = parts.find((p) => /^[A-Za-z][A-Za-z0-9]{1,5}$/.test(p) && !p.includes("[")) || "";
  const size = parts.find((p) => /^\d+(\.\d+)?\s?[KMG]B$/i.test(p)) || "";
  const year = parts.find((p) => /^\d{4}$/.test(p)) || "";
  const language = parts.find((p) => /\[[a-z-]+\]/i.test(p)) || "";

  const pageTitle = clean($("title").text()).replace(/\s*[-–]\s*Anna[’']s Archive\s*$/i, "");
  return {
    title: first(meta("meta[property='og:title']"), clean($("div.text-3xl").first().text()), pageTitle),
    authors: first(byIcon("user-edit"), clean($("div.italic").first().text())),
    publisher: byIcon("company"),
    edition: "",
    year,
    language,
    format: format.toUpperCase(),
    size,
    content_type: "",
    original_filename: "",
    identifiers,
    description: first(
      clean($(".js-md5-top-box-description").first().text()),
      meta("meta[property='og:description']"),
      meta("meta[name='description']")
    ),
  };
}

/** Render metadata (plus where the book came from) as a readable text file. */
export function formatMetadataText(meta, extra = {}) {
  const rows = [
    ["Title", meta.title],
    ["Author(s)", meta.authors],
    ["Publisher", meta.publisher],
    ["Edition", meta.edition],
    ["Year", meta.year],
    ["Language", meta.language],
    ["Format", meta.format],
    ["File size", meta.size],
    ["Content type", meta.content_type],
    ["Original filename", meta.original_filename],
  ];
  for (const [name, values] of Object.entries(meta.identifiers ?? {})) {
    if (name === "md5") continue; // listed once below
    rows.push([USEFUL_IDENTIFIERS[name] ?? name.toUpperCase().replace(/_/g, " "), values.join(", ")]);
  }
  rows.push(
    ["MD5", meta.md5],
    ["Anna's Archive", meta.url],
    ["Bookmark folder", extra.folder],
    ["Book file", extra.file],
    ["Metadata fetched", extra.fetched]
  );

  const present = rows.filter(([, v]) => v);
  const width = Math.max(...present.map(([k]) => k.length)) + 2;
  let out = present.map(([k, v]) => `${`${k}:`.padEnd(width)}${v}`).join("\n") + "\n";
  if (meta.description) {
    out += `\nDescription\n-----------\n${meta.description}\n`;
  }
  return out;
}
