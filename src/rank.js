/**
 * What kind of work a record is, and in which order its candidate files are tried.
 *
 * Order: free files before files that cost a download credit, then by how well
 * the candidate's title matched (same, other edition, contained in), then by
 * source priority. Files already rejected for this work are left out.
 */

const KINDS = [
  [/chapter/, "article"],
  [/book|monograph/, "book"],
  [/report|working|policy|guideline/, "report"],
  [/article|journal|proceedings|preprint|posted|paper/, "article"],
];

const kindOfType = (type) => KINDS.find(([re]) => re.test(String(type ?? "").toLowerCase()))?.[1];

/** "book", "article", "report" or "other". A type given with the input wins over source metadata. */
export function workKind(query, meta = {}) {
  return (
    kindOfType(query.type) ??
    kindOfType(meta.type) ??
    (query.isbn ? "book" : query.doi || query.arxiv || query.pmid || query.pmcid ? "article" : "other")
  );
}

const TIER = { same: 0, "other-edition": 1, "contained-in": 2 };

export function rankFiles(candidates, rejectedMd5s = []) {
  const seen = new Set(rejectedMd5s);
  const files = [];
  for (const c of candidates) {
    for (const f of c.files ?? []) {
      const key = f.md5 || f.url || JSON.stringify(f);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ ...f, source: c.source, tier: c.tier ?? "same" });
    }
  }
  const order = (f) => (f.credit ? 10 : 0) + TIER[f.tier];
  return files.map((f, i) => [f, i]).sort(([a, i], [b, j]) => order(a) - order(b) || i - j).map(([f]) => f);
}

const SMALL_PDF = 1024 * 1024;

/**
 * Why a file is probably not the whole book: "article" (a journal-article file)
 * or "small" (a PDF under 1 MB), else null. Uses what the source said about the
 * file (name, size, content type), so it works before downloading.
 */
export function excerptSignal(file) {
  if (file.contentType === "journal_article" || /scihub|scimag|[\\/]magz[\\/]/i.test(file.name ?? "")) return "article";
  if ((file.format ?? "pdf") === "pdf" && file.size > 0 && file.size < SMALL_PDF) return "small";
  return null;
}
