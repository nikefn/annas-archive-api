/**
 * Text comparison used wherever two titles, names or documents are matched.
 * One definition of "similar" for the whole project.
 */

const STOPWORDS = new Set(
  ("a an and are as at be by for from in into is of on or the to with via " +
    "der die das und von zu im la le les et des du de en el los las y")
    .split(" ")
);

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalise(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Significant words: normalised, no stopwords, at least 3 characters. */
export function words(text) {
  return normalise(text).split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Share of `needle`'s significant words that occur in `haystack` (0–1). */
export function coverage(needle, haystack) {
  const want = [...new Set(words(needle))];
  if (!want.length) return 0;
  const have = new Set(words(haystack));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** Symmetric title similarity (0–1): the weaker of the two coverages. */
export function similarity(a, b) {
  return Math.min(coverage(a, b), coverage(b, a));
}

/** Family name from "Family, Given" or "Given Family". */
export function surname(name) {
  const s = String(name ?? "").trim();
  if (s.includes(",")) return s.split(",")[0].trim();
  return s.split(/\s+/).pop() || "";
}
