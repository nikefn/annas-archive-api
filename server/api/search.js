import { mirrorFor, search } from "../../src/sources/annas.js";
import { getBearerKey } from "./bearer.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export default async function handler(req, res) {
  const query = (req.query.query || "").trim();
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
  const includeDownloads = req.query.downloads !== "false";
  // Required in practice: Anna's Archive challenges anonymous searches, so a
  // request without it fails with 401.
  const key = getBearerKey(req) || undefined;

  try {
    const baseUrl = req.query.tld ? mirrorFor(req.query.tld) : undefined;
    const results = await search(query, { limit, includeDownloads, key, baseUrl });
    res.status(200).json({ query, count: results.length, results });
  } catch (err) {
    // A bot check or a rejected key is a 401 the UI can act on.
    const status = err.code === "CHALLENGE" ? 401 : err.status || 502;
    res.status(status).json({ error: err.message, code: err.code });
  }
}
