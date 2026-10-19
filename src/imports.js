/**
 * Read a list of works from a file. The format follows the extension:
 *   .bib  BibTeX     .ris  RIS     .tsv  columns input, kind, language, gold
 *   anything else    one input per line, "#" starts a comment
 * Each entry becomes { input, hints }: the best identifier as input (DOI, then
 * ISBN, then URL, then title), the rest as hints for matching and checking.
 */

import { extname } from "node:path";

import { parseInput } from "./ids.js";
import { languageCode } from "./text.js";

/** BibTeX entry types -> the type hint rank.js understands; others give no hint. */
const BIBTEX_TYPES = {
  book: "book", mvbook: "book", booklet: "book",
  inbook: "chapter", incollection: "chapter", inproceedings: "chapter", conference: "chapter",
  article: "article", report: "report", techreport: "report", thesis: "thesis", phdthesis: "thesis",
  mastersthesis: "thesis",
};

function entry({ doi, isbn, url, title, authors, year, type, language, gold }) {
  const validIsbn = [].concat(isbn ?? []).find((i) => parseInput(`isbn:${i}`).isbn);
  const input = doi || (validIsbn && `isbn:${validIsbn}`) || url || title;
  if (!input) return null;
  const hints = { title, authors: authors?.length ? authors : undefined, year: Number(year) || undefined, type, language: languageCode(language), gold };
  for (const k of Object.keys(hints)) if (hints[k] === undefined || hints[k] === "") delete hints[k];
  return { input, hints };
}

/** BibTeX: entries of the form @type{key, field = {value} | "value" | number, ...}. */
export function parseBibtex(text) {
  const entries = [];
  const head = /@(\w+)\s*\{\s*[^,]*,/g;
  let m;
  while ((m = head.exec(text))) {
    const fields = {};
    let i = head.lastIndex;
    for (;;) {
      const f = /\s*([\w-]+)\s*=\s*/y;
      f.lastIndex = i;
      const name = f.exec(text);
      if (!name) break;
      i = f.lastIndex;
      let value = "";
      if (text[i] === "{" || text[i] === '"') {
        const close = text[i] === "{" ? "}" : '"';
        let depth = 0;
        let j = i;
        for (; j < text.length; j++) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}" && close === "}") depth--;
          if ((close === "}" && depth === 0) || (close === '"' && j > i && text[j] === '"' && depth === 0)) break;
        }
        value = text.slice(i + 1, j);
        i = j + 1;
      } else {
        const bare = /[^,}\s]+/y;
        bare.lastIndex = i;
        value = bare.exec(text)?.[0] ?? "";
        i = bare.lastIndex;
      }
      fields[name[1].toLowerCase()] = value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      const sep = /\s*,?/y;
      sep.lastIndex = i;
      sep.exec(text);
      i = sep.lastIndex;
    }
    head.lastIndex = i;
    entries.push(
      entry({
        doi: fields.doi,
        isbn: fields.isbn?.split(/[,;\s]+/),
        url: fields.url,
        title: fields.title,
        authors: fields.author?.split(/\s+and\s+/i),
        year: fields.year ?? fields.date?.slice(0, 4),
        type: BIBTEX_TYPES[m[1].toLowerCase()],
        language: fields.language ?? fields.langid,
      })
    );
  }
  return entries.filter(Boolean);
}

/** RIS: "TAG  - value" lines, records ending with ER. */
export function parseRis(text) {
  const entries = [];
  let rec = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/);
    if (!m) continue;
    const [, tag, value] = m;
    if (tag === "ER") {
      entries.push(
        entry({
          doi: rec.DO?.[0],
          isbn: rec.SN,
          url: rec.UR?.[0],
          title: (rec.TI ?? rec.T1)?.[0],
          authors: rec.AU ?? rec.A1,
          year: (rec.PY ?? rec.Y1)?.[0]?.slice(0, 4),
          type: { JOUR: "article", BOOK: "book", CHAP: "chapter", RPRT: "report", THES: "thesis" }[rec.TY?.[0]],
          language: rec.LA?.[0],
        })
      );
      rec = {};
    } else {
      (rec[tag] ??= []).push(value.trim());
    }
  }
  return entries.filter(Boolean);
}

/** TSV with a header row naming the columns input, kind, language, gold. */
export function parseTsv(text) {
  const [header = "", ...rows] = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const cols = header.split("\t").map((c) => c.trim());
  return rows.map((row) => {
    const cells = Object.fromEntries(row.split("\t").map((c, i) => [cols[i], c.trim()]));
    const hints = { type: cells.kind || undefined, language: languageCode(cells.language), gold: cells.gold || undefined };
    for (const k of Object.keys(hints)) if (!hints[k]) delete hints[k];
    return { input: cells.input, hints };
  }).filter((item) => item.input);
}

const parseLines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((input) => ({ input, hints: {} }));

export function parseList(text, path = "") {
  const parser = { ".bib": parseBibtex, ".ris": parseRis, ".tsv": parseTsv }[extname(path).toLowerCase()] ?? parseLines;
  return parser(text);
}
