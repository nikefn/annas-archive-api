/**
 * Builders for the documents the tests check: minimal but valid PDFs and EPUBs,
 * generated in memory so no binary fixtures are needed.
 */

import { strToU8, zipSync } from "fflate";

/** A PDF with one line of text per page. `truncate` drops the %%EOF trailer. */
export function makePdf(pages, { truncate = false } = {}) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    // One short line per 60 characters: text past the page edge is not extracted.
    const lines = text.replace(/[()\\]/g, "").match(/.{1,60}(\s|$)/g) ?? [];
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n`;
  if (!truncate) out += "%%EOF\n";
  return Buffer.from(out, "latin1");
}

/** An EPUB with the given title, creator and chapter texts. */
export function makeEpub({ title, creator, chapters }) {
  const manifest = chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`);
  const files = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
    ),
    "OEBPS/content.opf": strToU8(
      `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title>` +
        `<dc:creator>${creator}</dc:creator></metadata><manifest>${manifest.join("")}</manifest>` +
        `<spine>${spine.join("")}</spine></package>`
    ),
  };
  chapters.forEach((text, i) => {
    files[`OEBPS/c${i}.xhtml`] = strToU8(`<html><body><p>${text}</p></body></html>`);
  });
  return Buffer.from(zipSync(files));
}

/** Filler that gives a page a realistic amount of extractable text. */
export const prose = (words = 60) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
