/**
 * The quality standard: every check a downloaded file goes through, in order.
 * Each rule returns { status: "pass" | "warn" | "fail", detail } or null when
 * it does not apply. A file's verdict is its worst status:
 *   fail -> file rejected, next candidate tried
 *   warn -> file kept, work marked "review"
 *   pass -> file kept, work marked "done"
 */

import { ACCEPTED_FORMATS } from "./file.js";
import { coverage, detectLanguage, normalise, surname, titleMatch } from "../text.js";

const MIN_CHARS_PER_PAGE = 100; // below this a PDF is probably a scan without OCR
const TITLE_PASS = 0.8; // share of title words found in the opening pages
const TITLE_WARN = 0.5;
const MIN_PAGE_SHARE = 0.5; // fewer pages than this share of the expected count = partial
const MIN_PAGES = { book: 40, article: 2 }; // when the expected count is unknown
const IDENTITY_PAGES = 5;

const pass = (detail) => ({ status: "pass", detail });
const warn = (detail) => ({ status: "warn", detail });
const fail = (detail) => ({ status: "fail", detail });

/** Embedded title and authors plus the first pages: what identity is judged on. */
const openingText = ({ doc }) =>
  [doc.title, ...(doc.authors ?? []), ...doc.pageTexts.slice(0, IDENTITY_PAGES)].filter(Boolean).join(" ");

const hasTextLayer = ({ doc }) =>
  doc.pageTexts.length > 0 &&
  doc.pageTexts.join("").length / doc.pageTexts.length >= MIN_CHARS_PER_PAGE;

export const RULES = [
  ["format", ({ doc }) =>
    ACCEPTED_FORMATS.includes(doc.format) ? pass(doc.format) : fail(`not a document: ${doc.format}`)],

  ["opens", ({ doc }) => {
    if (!doc.opened) return fail(doc.error || "could not be opened");
    return pass(doc.pages ? `${doc.pages} pages` : doc.pageTexts.length ? "parsed" : "header only");
  }],

  ["drm", ({ doc }) => (doc.drm ? fail("DRM-protected EPUB") : null)],

  ["hash", ({ file, expected }) => {
    if (!expected.md5) return null;
    return file.md5 === expected.md5.toLowerCase()
      ? pass("md5 matches source")
      : fail(`md5 ${file.md5} != source ${expected.md5}`);
  }],

  ["duplicate", ({ file, duplicates }) => {
    const other = duplicates.get(file.sha256);
    return other ? warn(`same file as ${other}`) : pass("unique in library");
  }],

  ["text-layer", (ctx) => {
    if (!ctx.doc.pageTexts.length) return warn(`${ctx.doc.format} text not inspected`);
    return hasTextLayer(ctx) ? pass("text extractable") : warn("little or no text (scan without OCR?)");
  }],

  ["identity", (ctx) => {
    const { meta } = ctx;
    const text = openingText(ctx);
    const doi = meta.doi && normalise(ctx.doc.pageTexts.slice(0, 2).join(" "));
    if (doi && doi.includes(normalise(meta.doi))) return pass("DOI printed in document");
    if (!meta.title) return warn("no title to compare against");
    const share = coverage(meta.title, text);
    const pct = `${Math.round(share * 100)}% of title words found`;
    if (share >= TITLE_PASS) return pass(pct);
    if (share >= TITLE_WARN || !hasTextLayer(ctx)) return warn(pct);
    return fail(pct);
  }],

  ["author", (ctx) => {
    const name = surname(ctx.meta.authors?.[0]);
    if (normalise(name).length < 3 || !ctx.doc.pageTexts.length) return null;
    return normalise(openingText(ctx)).includes(normalise(name))
      ? pass(`${name} found`)
      : warn(`${name} not found in opening pages`);
  }],

  ["length", ({ doc, meta, kind }) => {
    if (!doc.pages) return null;
    if (meta.pages) {
      const detail = `${doc.pages} of ${meta.pages} expected pages`;
      return doc.pages < meta.pages * MIN_PAGE_SHARE ? fail(`${detail} (partial or preview?)`) : pass(detail);
    }
    const min = MIN_PAGES[kind];
    if (!min) return null;
    return doc.pages < min ? fail(`${doc.pages} pages, a ${kind} needs ${min}`) : pass(`${doc.pages} pages`);
  }],

  // A chapter printed from an online platform carries "Page n of N" with N = its own page count.
  ["printout", ({ doc, kind }) => {
    if (kind !== "book" || !doc.pages) return null;
    const printed = doc.pageTexts.some((t) =>
      [...t.matchAll(/page \d+ of (\d+)/gi)].some((m) => Number(m[1]) === doc.pages)
    );
    return printed ? fail(`"Page n of ${doc.pages}" printout, not the book`) : null;
  }],

  ["language", ({ doc, language }) => {
    if (!language) return null;
    const found = detectLanguage(doc.pageTexts.join(" "));
    if (!found) return null;
    return found === language ? pass(found) : fail(`text is ${found}, work wants ${language}`);
  }],

  ["metadata-complete", ({ meta }) => {
    const missing = ["title", "authors", "year"].filter((k) => !(meta[k]?.length ?? meta[k]));
    return missing.length ? warn(`missing ${missing.join(", ")}`) : pass("title, authors, year");
  }],

  ["metadata-agreement", ({ meta, candidates }) => {
    const described = candidates.filter((c) => c.meta.title);
    const off = described.filter(
      (c) =>
        !titleMatch(meta.title, c.meta.title) ||
        (c.tier === "same" && c.meta.year && meta.year && Math.abs(c.meta.year - meta.year) > 1)
    );
    if (off.length) return warn(`disagree: ${off.map((c) => c.source).join(", ")}`);
    const n = new Set(described.map((c) => c.source)).size;
    return pass(n > 1 ? `${n} sources agree` : "single source");
  }],

  ["retraction", ({ meta }) => (meta.retracted ? warn("marked as retracted") : null)],
];

/** Run the rules in order, stopping at the first failure. */
export function evaluate(ctx) {
  const checks = [];
  for (const [name, rule] of RULES) {
    const result = rule(ctx);
    if (!result) continue;
    checks.push({ name, ...result });
    if (result.status === "fail") break;
  }
  return checks;
}

const RANK = { pass: 0, warn: 1, fail: 2 };

export const verdictOf = (checks) =>
  checks.reduce((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), "pass");
