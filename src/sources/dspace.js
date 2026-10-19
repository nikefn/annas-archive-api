/**
 * DSpace 7+ repositories (REST API): WHO IRIS, World Bank and FAO Open
 * Knowledge, many university and agency repositories. One adapter, any number
 * of instances, listed in DSPACE_REPOSITORIES. The bitstream link needs two
 * extra calls, so it is looked up only when a file is actually tried.
 */

import { config } from "../config.js";
import { client } from "../http.js";
import { bareDoi, searchTerms, yearOf } from "./meta.js";

const http = client({ minIntervalMs: 500 });
const PER_REPOSITORY = 3;

export function toCandidate(item, base) {
  const all = (key) => (item.metadata?.[key] ?? []).map((v) => v.value).filter(Boolean);
  return {
    meta: {
      title: all("dc.title")[0] ?? item.name,
      authors: [...all("dc.contributor.author"), ...all("dc.creator")],
      year: yearOf(all("dc.date.issued")[0]),
      doi: bareDoi(all("dc.identifier.doi")[0]),
      isbn: all("dc.identifier.isbn"),
      type: all("dc.type")[0],
      publisher: all("dc.publisher")[0],
      language: all("dc.language.iso")[0],
      url: item.handle ? `${base}/handle/${item.handle}` : undefined,
    },
    files: [{ dspace: { base, uuid: item.uuid } }],
  };
}

async function search(base, query) {
  const params = new URLSearchParams({ query, dsoType: "ITEM", size: String(PER_REPOSITORY) });
  const data = await http.json(`${base}/server/api/discover/search/objects?${params}`);
  return (data._embedded?.searchResult?._embedded?.objects ?? [])
    .map((o) => o._embedded?.indexableObject)
    .filter(Boolean)
    .map((item) => toCandidate(item, base));
}

export default {
  id: "dspace",
  name: "DSpace repositories",
  missing: () => (config.dspaceRepositories.length ? [] : ["DSPACE_REPOSITORIES"]),

  async find(q) {
    const query = q.doi ? `"${q.doi}"` : q.title ? searchTerms(q.title) : null;
    if (!query) return [];
    const settled = await Promise.allSettled(config.dspaceRepositories.map((base) => search(base, query)));
    return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  },

  /** First bitstream of the ORIGINAL bundle, with its md5 when the repository reports one. */
  async resolve({ dspace: { base, uuid } }) {
    const bundles = await http.json(`${base}/server/api/core/items/${uuid}/bundles`);
    const original = bundles._embedded?.bundles?.find((b) => b.name === "ORIGINAL");
    if (!original) throw new Error("item has no files");
    const list = await http.json(original._links.bitstreams.href);
    const bitstream = list._embedded?.bitstreams?.[0];
    if (!bitstream) throw new Error("item has no files");
    const sum = bitstream.checkSum;
    return {
      url: bitstream._links.content.href,
      md5: sum?.checkSumAlgorithm === "MD5" ? sum.value : undefined,
    };
  },
};
