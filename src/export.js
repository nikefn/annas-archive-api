/**
 * RIS export. Zotero, Mendeley, EndNote and most reference managers import it,
 * and the L1 field attaches the downloaded file during import.
 */

import { join } from "node:path";

import { workDir } from "./store.js";

const RIS_TYPES = [
  [/book-chapter|chapter/, "CHAP"],
  [/book|monograph/, "BOOK"],
  [/report|working|policy/, "RPRT"],
  [/thesis|dissertation/, "THES"],
  [/proceedings|conference/, "CONF"],
  [/journal|article|preprint|posted|review/, "JOUR"],
];

const risType = (type) => RIS_TYPES.find(([re]) => re.test(String(type ?? "").toLowerCase()))?.[1] ?? "GEN";

export function toRis(works) {
  const lines = [];
  for (const w of works) {
    const m = w.meta ?? { title: w.query.title };
    const field = (tag, value) => value && lines.push(`${tag}  - ${String(value).replace(/\s+/g, " ")}`);
    field("TY", risType(m.type));
    field("TI", m.title);
    for (const a of m.authors ?? []) field("AU", a);
    field("PY", m.year);
    field("DO", m.doi);
    for (const isbn of m.isbn ?? []) field("SN", isbn);
    field("T2", m.venue);
    field("PB", m.publisher);
    field("LA", m.language);
    field("UR", m.doi ? `https://doi.org/${m.doi}` : m.url);
    if (w.file) field("L1", join(workDir(w.id), w.file.name));
    field("N1", `litfetch ${w.id}: ${w.status}`);
    lines.push("ER  - ", "");
  }
  return lines.join("\n");
}
