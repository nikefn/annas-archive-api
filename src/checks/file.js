/**
 * File-level facts: what format a file really is (by its bytes, never by its
 * name or Content-Type), whether it opens, and its text for the content checks.
 */

import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { load } from "cheerio";
import { unzipSync, strFromU8 } from "fflate";

/** Formats litfetch keeps. Anything else (HTML or JSON error pages, unknown blobs) fails. */
export const ACCEPTED_FORMATS = ["pdf", "epub", "djvu", "mobi"];

const PAGES_READ = 10;

/** Identify a file from its first bytes. */
export function detectFormat(head) {
  const ascii = Buffer.from(head).toString("latin1");
  if (ascii.startsWith("%PDF-")) return "pdf";
  if (ascii.startsWith("AT&TFORM")) return "djvu";
  if (ascii.slice(60, 68) === "BOOKMOBI") return "mobi";
  if (ascii.startsWith("PK\x03\x04")) {
    return ascii.slice(30, 58) === "mimetypeapplication/epub+zip" ? "epub" : "zip";
  }
  if (/^\s*(<!doctype html|<html|<\?xml)/i.test(ascii)) return "html";
  if (/^\s*[{[]/.test(ascii)) return "json";
  return "unknown";
}

/**
 * Open a file and extract what the checks need:
 *   { format, opened, error?, pages?, pageTexts: string[], title?, authors?, drm? }
 * `pageTexts` is per page for PDF and per spine document for EPUB.
 */
export async function readDocument(path) {
  const buf = await readFile(path);
  const format = detectFormat(buf.subarray(0, 64));
  const doc = { format, opened: false, pageTexts: [] };
  try {
    if (format === "pdf") Object.assign(doc, await readPdf(buf));
    else if (format === "epub") Object.assign(doc, readEpub(buf));
    else doc.opened = ACCEPTED_FORMATS.includes(format);
  } catch (err) {
    doc.error = err.message;
  }
  return doc;
}

async function readPdf(buf) {
  if (!buf.subarray(-2048).toString("latin1").includes("%%EOF")) {
    throw new Error("truncated: no %%EOF marker");
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buf), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pageTexts = [];
    for (let i = 1; i <= Math.min(pdf.numPages, PAGES_READ); i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      pageTexts.push(content.items.map((item) => item.str).join(" "));
    }
    const { info } = await pdf.getMetadata();
    return {
      opened: true,
      pages: pdf.numPages,
      pageTexts,
      title: info?.Title || undefined,
      authors: info?.Author ? [info.Author] : undefined,
    };
  } finally {
    await task.destroy();
  }
}

const FONT = /\.(ttf|otf|woff2?)$/i;

function readEpub(buf) {
  // The end-of-central-directory record sits in the last 64 KB; without it the archive was cut off.
  if (!buf.subarray(-65_557).includes(Buffer.from("PK\x05\x06", "latin1"))) {
    throw new Error("truncated: no end of ZIP directory");
  }
  const u8 = new Uint8Array(buf);
  const pick = (names) => unzipSync(u8, { filter: (f) => names.includes(f.name) });

  // DRM: rights.xml, or encryption.xml covering more than font obfuscation.
  const rights = pick(["META-INF/rights.xml", "META-INF/encryption.xml"]);
  const encrypted = rights["META-INF/encryption.xml"]
    ? load(strFromU8(rights["META-INF/encryption.xml"]), { xmlMode: true })("CipherReference, enc\\:CipherReference")
        .map((_, el) => el.attribs.URI)
        .get()
        .filter((uri) => !FONT.test(uri))
    : [];
  const drm = Boolean(rights["META-INF/rights.xml"]) || encrypted.length > 0;

  const container = pick(["META-INF/container.xml"])["META-INF/container.xml"];
  if (!container) throw new Error("no META-INF/container.xml");
  const opfPath = load(strFromU8(container), { xmlMode: true })("rootfile").attr("full-path");
  const opfRaw = opfPath && pick([opfPath])[opfPath];
  if (!opfRaw) throw new Error("package document missing");

  const $ = load(strFromU8(opfRaw), { xmlMode: true });
  const base = posix.dirname(opfPath);
  const hrefs = Object.fromEntries(
    $("manifest > item").map((_, el) => [[$(el).attr("id"), $(el).attr("href")]]).get()
  );
  const spine = $("spine > itemref")
    .map((_, el) => hrefs[$(el).attr("idref")])
    .get()
    .slice(0, PAGES_READ)
    .map((href) => posix.join(base, decodeURIComponent(href)));
  const files = pick(spine);
  const pageTexts = spine
    .filter((name) => files[name])
    .map((name) => load(strFromU8(files[name])).root().text().replace(/\s+/g, " ").trim());

  return {
    opened: true,
    drm,
    pageTexts,
    title: $("dc\\:title, title").first().text().trim() || undefined,
    authors: $("dc\\:creator, creator").map((_, el) => $(el).text().trim()).get(),
  };
}
