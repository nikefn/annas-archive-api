/** Small converters shared by the source adapters. */

/** "https://doi.org/10.1/X" -> "10.1/x" */
export const bareDoi = (doi) =>
  doi ? String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : undefined;

/** First four-digit year in a value, as a number. */
export function yearOf(value) {
  const m = String(value ?? "").match(/\b(1[5-9]|20)\d{2}\b/);
  return m ? Number(m[0]) : undefined;
}

/** Page count from "123-145" or first/last page numbers. */
export function pageCount(first, last) {
  if (last === undefined && typeof first === "string" && first.includes("-")) {
    [first, last] = first.split("-");
  }
  const a = parseInt(first, 10);
  const b = parseInt(last, 10);
  return a > 0 && b >= a ? b - a + 1 : undefined;
}

/** "Family, Given" from separate parts, or whichever part exists. */
export const personName = (family, given) =>
  [family, given].filter(Boolean).join(", ") || undefined;

/** Words for a title search: drop characters that break query syntaxes. */
export const searchTerms = (title) => String(title).replace(/["():\[\]{}^~*?\\/]+/g, " ").trim();
