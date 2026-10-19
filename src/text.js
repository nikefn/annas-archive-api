/**
 * Text comparison used wherever titles, names or documents are matched. One
 * definition of "similar" for the whole project.
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

/** Share of `needle`'s significant words that occur in `haystack` (0 to 1). */
export function coverage(needle, haystack) {
  const want = [...new Set(words(needle))];
  if (!want.length) return 0;
  const have = new Set(words(haystack));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** Symmetric similarity (0 to 1): the weaker of the two coverages. */
export function similarity(a, b) {
  return Math.min(coverage(a, b), coverage(b, a));
}

/** Family name from "Family, Given" or "Given Family". */
export function surname(name) {
  const s = String(name ?? "").trim();
  if (s.includes(",")) return s.split(",")[0].trim();
  return s.split(/\s+/).pop() || "";
}

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
const romanValue = (s) =>
  [...s].reduce((sum, ch, i, all) => sum + (ROMAN[ch] < (ROMAN[all[i + 1]] ?? 0) ? -ROMAN[ch] : ROMAN[ch]), 0);

const VOLUME = /\b(?:vol|volume|volumes|band|bd|tome|tomo|part|teil|book|livre|libro)\.?\s*(\d+|[ivxlc]+)\b/i;

/** Volume or part number of a title ("Vol. 2", "Part II", "Band 3"), or null. */
export function volumeOf(title) {
  const m = String(title ?? "").match(VOLUME);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : romanValue(m[1].toLowerCase());
}

const splitTitle = (title) => {
  const [main, ...rest] = String(title ?? "").split(/\s*[:;]\s*|\s+[-–]\s+/);
  return [main, rest.join(" ")];
};

const SAME = 0.85; // share of words two titles must share to be the same title
const SUBTITLE = 0.5; // below this, two different subtitles mean another edition or work

/**
 * How a found title relates to the wanted one:
 *   "same"           same main title, compatible subtitle and volume
 *   "other-edition"  same main title, different subtitle
 *   "contained-in"   the wanted title appears inside a longer title (anthology, collected works)
 *   null             different work, including a different volume or part number
 * A wanted "title" may be a whole citation: a found title it contains counts as "same".
 */
export function titleMatch(wanted, found) {
  const vw = volumeOf(wanted);
  const vf = volumeOf(found);
  if (vw !== null && vf !== null && vw !== vf) return null;
  const [wm, ws] = splitTitle(wanted);
  const [fm, fs] = splitTitle(found);
  if (similarity(wm, fm) >= SAME) return ws && fs && similarity(ws, fs) < SUBTITLE ? "other-edition" : "same";
  if (words(found).length >= 2 && coverage(found, wanted) >= SAME) return "same";
  if (coverage(wm, found) >= SAME) return "contained-in";
  return null;
}

const LANGUAGE_WORDS = {
  en: "the and of to in is that for with as was on are by this be",
  de: "der die und das ist nicht ein eine zu den von mit sich auf dem",
  fr: "le la les et des est une que pour dans qui pas sur par du",
  es: "el la los las y que del en una por con para es como pero",
  it: "il la che di per una non sono della con del come anche gli",
  pt: "o a os que do da em um uma para com não por dos das",
  nl: "de het een en van is dat niet op voor met zijn aan ook",
};
const LANGUAGE_SETS = Object.entries(LANGUAGE_WORDS).map(([lang, w]) => [lang, new Set(w.split(" "))]);

/** ISO 639-1 code of a text's language when one of the supported ones clearly dominates, else null. */
export function detectLanguage(text) {
  const tokens = String(text ?? "").toLowerCase().split(/[^\p{L}]+/u);
  const scores = LANGUAGE_SETS.map(([lang, set]) => [lang, tokens.filter((t) => set.has(t)).length]).sort(
    (a, b) => b[1] - a[1]
  );
  const [[lang, top], [, second]] = scores;
  return top >= 20 && top >= 2 * second ? lang : null;
}
