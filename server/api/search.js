import { mirrorFor, search } from "../../src/sources/annas.js";
import { getBearerKey, param } from "./input.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** GET ?query=&limit=&downloads=&tld= : Anna's Archive search results. */
export default async function handler(req, res) {
  const query = param(req, "query");
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(param(req, "limit"), 10) || DEFAULT_LIMIT));
  try {
    const baseUrl = param(req, "tld") ? mirrorFor(param(req, "tld")) : undefined;
    const results = await search(query, {
      limit,
      includeDownloads: param(req, "downloads") !== "false",
      key: getBearerKey(req) || undefined,
      baseUrl,
    });
    res.status(200).json({ query, count: results.length, results });
  } catch (err) {
    // A bot check means the key is missing or wrong: something the user can fix in Settings.
    res.status(err.code === "CHALLENGE" ? 401 : err.status || 502).json({ error: err.message, code: err.code });
  }
}
