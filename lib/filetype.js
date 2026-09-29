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

/**
 * Structural check that a file of type `ext` is complete: formats with an
 * end marker or a declared length reveal truncation. `head` and `tail` are the
 * first and last bytes of the file. Returns a problem description or null.
 */
export function checkIntegrity(ext, { head, tail, size }) {
  if (size === 0) return "file is empty";
  switch (ext) {
    case "pdf":
      return tail.includes("%%EOF", 0, "latin1") ? null : "PDF is truncated (no %%EOF marker at the end)";
    case "epub":
    case "zip":
    case "docx":
    case "cbz":
      return tail.includes("PK\x05\x06", 0, "latin1")
        ? null
        : "archive is truncated (no end-of-directory record)";
    case "djvu": {
      if (head.length < 12) return "DjVu header is incomplete";
      const declared = head.readUInt32BE(8) + 12;
      return size >= declared ? null : `DjVu is truncated (${size} of ${declared} bytes)`;
    }
    default:
      return null;
  }
}

/** Cut `text` to at most `max` characters, at a word boundary where possible. */
export function truncateWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,;:–-]+$/, "");
}

/** Characters macOS, Windows or e-readers choke on, plus control characters. */
export function safeName(name, max = 150) {
  const cleaned = name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return truncateWords(cleaned, max).replace(/^[.\s]+|[.\s]+$/g, "");
}
