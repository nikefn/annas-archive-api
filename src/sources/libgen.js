/**
 * Library Genesis ("libgen-plus" mirrors such as libgen.li): shadow library of
 * books and articles. Opt-in source, no account needed.
 *
 * Only identifiers are scraped from the search page (edition id and file md5);
 * metadata comes from the mirror's JSON API, which changes far less than the
 * HTML. Mirrors (LIBGEN_MIRRORS) are tried starting with the last one that worked.
 */

import { load } from "cheerio";

import { config } from "../config.js";
import { client, mirrorSet } from "../http.js";
import { bareDoi, yearOf } from "./meta.js";

const http = client();
const mirrors = mirrorSet(config.libgenMirrors.map((m) => m.replace(/\/$/, "")));
const MAX_RESULTS = 5;

/** [{ editionId, md5 }] from a search results page. */
export function parseSearchPage(html) {
  const $ = load(html);
  const rows = [];
  $("#tablelibgen tr").each((_, tr) => {
    const row = $(tr);
    const editionId = row.find('a[href*="edition.php?id="]').attr("href")?.match(/id=(\d+)/)?.[1];
    const md5 = row.find('a[href*="md5="]').attr("href")?.match(/md5=([a-f0-9]{32})/i)?.[1];
    if (editionId && md5) rows.push({ editionId, md5: md5.toLowerCase() });
  });
  return rows;
}

/** Candidate from one edition record of json.php?object=e. */
export function toCandidate(edition, md5) {
  return {
    meta: {
      title: [edition.title, edition.title_add].filter(Boolean).join(": ") || undefined,
      authors: String(edition.author ?? "").split(/;\s*/).filter(Boolean),
      year: yearOf(edition.year),
      doi: bareDoi(edition.doi || undefined),
      publisher: edition.publisher || undefined,
      pages: parseInt(edition.pages, 10) || undefined,
      md5,
    },
    files: [{ md5 }],
  };
}

/** Name, size and format of a file from its json.php?object=f record. */
export function describeFile(record) {
  const f = Object.values(record ?? {})[0];
  if (!f) return {};
  return { name: f.locator || undefined, size: Number(f.filesize) || undefined, format: f.extension || undefined };
}

/** json.php answers "nothing found" with a bare [] instead of an object. */
async function jsonObject(url) {
  const data = await http.json(url);
  return Array.isArray(data) ? {} : data;
}

/** Exact DOI lookup: every file of every matching edition. */
async function byDoi(mirror, doi) {
  const editions = await jsonObject(`${mirror}/json.php?${new URLSearchParams({ object: "e", doi, addkeys: "*" })}`);
  return Object.values(editions).flatMap((e) =>
    Object.values(e.files ?? {}).map((f) => toCandidate(e, f.md5.toLowerCase()))
  );
}

export default {
  id: "libgen",
  name: "Library Genesis",
  missing: () => (config.libgenMirrors.length ? [] : ["LIBGEN_MIRRORS"]),

  async find(q) {
    if (q.doi) return mirrors.run((mirror) => byDoi(mirror, q.doi));
    const term = q.md5 || q.isbn || q.title;
    if (!term) return [];
    return mirrors.run(async (mirror) => {
      const html = await http.text(`${mirror}/index.php?${new URLSearchParams({ req: term, res: "25" })}`);
      const rows = parseSearchPage(html).slice(0, MAX_RESULTS);
      if (!rows.length) return [];
      const ids = [...new Set(rows.map((r) => r.editionId))].join(",");
      const editions = await jsonObject(`${mirror}/json.php?object=e&addkeys=*&ids=${ids}`);
      return rows.filter((r) => editions[r.editionId]).map((r) => toCandidate(editions[r.editionId], r.md5));
    });
  },

  async describe({ md5 }) {
    return describeFile(await mirrors.run((mirror) => jsonObject(`${mirror}/json.php?object=f&md5=${md5}`)));
  },

  /** Each mirror's download page carries a fresh "get.php?md5=...&key=..." link. */
  async *links({ md5 }) {
    for (const mirror of mirrors.ordered()) {
      let href;
      try {
        href = load(await http.text(`${mirror}/ads.php?md5=${md5}`))('a[href*="get.php?md5="]').attr("href");
      } catch {
        continue;
      }
      if (!href) continue;
      mirrors.worked(mirror);
      yield { url: new URL(href, `${mirror}/`).toString(), md5 };
    }
  },
};
