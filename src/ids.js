/**
 * Identifiers: turn one line of user input into a query, and a query into a
 * stable, readable folder name. The PATTERNS table is the full list of
 * recognised identifier kinds; anything else is treated as a title or citation.
 */

import { createHash } from "node:crypto";

import { asciiFold } from "./text.js";

const PATTERNS = [
  ["doi", /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i],
  ["arxiv", /^(?:arxiv:\s*|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i],
  ["pmid", /^pmid:\s*(\d{1,9})$/i],
  ["pmcid", /^(?:pmcid:\s*)?(PMC\d+)$/i],
  ["isbn", /^(?:isbn:?\s*)?((?:97[89][\d-]{10,14})|(?:\d[\d-]{8,11}[\dX]))$/i],
  ["md5", /^(?:md5:\s*)?([a-f0-9]{32})$/i],
  ["celex", /^celex:\s*([0-9A-Z()]+)$/i],
  ["symbol", /^symbol:\s*(\S.+)$/i],
  ["url", /^(https?:\/\/\S+)$/i],
];

/** Normalise an identifier value so equal ids compare equal. */
export function normaliseId(kind, value) {
  const v = String(value).trim();
  if (kind === "doi") return v.toLowerCase().replace(/[.,;]+$/, "");
  if (kind === "isbn") return v.replace(/-/g, "").toUpperCase();
  if (kind === "arxiv") return v.replace(/v\d+$/, "");
  if (kind === "md5") return v.toLowerCase();
  if (kind === "pmcid" || kind === "celex") return v.toUpperCase();
  return v;
}

/** One line of input -> query object, e.g. { doi: "10.1/x" } or { title: "..." }. */
export function parseInput(line) {
  const text = String(line).trim();
  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (m && (kind !== "isbn" || validIsbn(m[1]))) return { [kind]: normaliseId(kind, m[1]) };
  }
  return { title: text };
}

function validIsbn(raw) {
  const s = raw.replace(/-/g, "").toUpperCase();
  if (s.length === 10) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  if (s.length === 13) {
    const sum = [...s].reduce((acc, c, i) => acc + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  return false;
}

/** Identifier kinds in the order used to name a work's folder. */
export const ID_KINDS = ["doi", "arxiv", "pmcid", "pmid", "isbn", "celex", "symbol", "md5", "url"];

/** Stable folder name for a query: "<kind>-<value>" or "title-<slug>-<hash>". */
export function workId(query) {
  const kind = ID_KINDS.find((k) => query[k]);
  if (kind && kind !== "url") return `${kind}-${slug(query[kind], 80)}`;
  const basis = query.url || query.title;
  const hash = createHash("sha1").update(basis).digest("hex").slice(0, 8);
  return `${kind || "title"}-${slug(basis.replace(/^https?:\/\//, ""), 50)}-${hash}`;
}

/** Lowercase ASCII slug, safe as a file or folder name on every OS. */
export function slug(text, max = 60) {
  return (
    asciiFold(text)
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, max)
      .replace(/[-.]+$/, "") || "untitled"
  );
}
