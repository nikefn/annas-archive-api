/**
 * UN Official Document System: every official UN document by its symbol
 * (e.g. "symbol: A/RES/70/1"). Fetch only — ODS has no public search API.
 * A missing symbol comes back as a small HTML page, which the format check rejects.
 */

export default {
  id: "unods",
  name: "UN Official Document System",
  missing: () => [],

  async find(q) {
    if (!q.symbol) return [];
    const params = new URLSearchParams({ s: q.symbol, l: "en", t: "pdf" });
    return [
      {
        meta: { symbol: q.symbol, publisher: "United Nations" },
        files: [{ url: `https://documents.un.org/api/symbol/access?${params}` }],
      },
    ];
  },
};
