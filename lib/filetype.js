/**
 * Identify a downloaded file by its first bytes rather than its name.
 *
 * Fast-download URLs don't reliably end in an extension, and a failed download
 * can come back as an HTML error page with a 200. Checking the magic bytes
 * gives the right extension and catches files that aren't books at all.
 */

const ascii = (buf, start, end) => buf.subarray(start, end).toString("latin1");

/**
 * Return `{ ext, valid }`. `valid` is false for empty files and HTML/JSON
 * responses (error pages, not books). `ext` is null when the type is unknown.
 */
export function sniffFile(buf) {
  if (!buf || buf.length === 0) return { ext: null, valid: false, kind: "empty file" };

  const head = ascii(buf, 0, 1024);
  if (head.startsWith("%PDF")) return { ext: "pdf", valid: true };
  if (head.startsWith("AT&TFORM")) return { ext: "djvu", valid: true };
  if (head.startsWith("PK\x03\x04")) {
    // EPUB puts an uncompressed `mimetype` entry first; DOCX has word/ entries.
    if (head.includes("application/epub+zip")) return { ext: "epub", valid: true };
    if (head.includes("word/")) return { ext: "docx", valid: true };
    return { ext: "zip", valid: true };
  }
  if (ascii(buf, 60, 68) === "BOOKMOBI") return { ext: "mobi", valid: true };
  if (head.startsWith("Rar!")) return { ext: "rar", valid: true };
  if (head.startsWith("7z\xBC\xAF\x27\x1C")) return { ext: "7z", valid: true };
  if (head.startsWith("ITSF")) return { ext: "chm", valid: true };
  if (head.startsWith("{\\rtf")) return { ext: "rtf", valid: true };
  if (head.startsWith("\xD0\xCF\x11\xE0")) return { ext: "doc", valid: true };
  if (head.startsWith("\x1F\x8B")) return { ext: "gz", valid: true };

  const text = head.replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart().toLowerCase();
  if (text.startsWith("<?xml") && text.includes("<fictionbook")) return { ext: "fb2", valid: true };
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.includes("<head")) {
    return { ext: null, valid: false, kind: "HTML page (an error page, not a book)" };
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    return { ext: null, valid: false, kind: "JSON response (an error, not a book)" };
  }
  return { ext: null, valid: true, kind: "unknown type" };
}

const KNOWN_EXT = /\.(pdf|epub|mobi|azw3?|djvu|fb2|docx?|rtf|chm|zip|rar|7z|gz|cbz|cbr|txt|lit|bin)$/i;

/** Swap a recognised extension for `ext`, or append it if there is none. */
export function withExtension(name, ext) {
  return `${name.replace(KNOWN_EXT, "")}.${ext}`;
}
