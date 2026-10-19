import { fastDownload, mirrorFor } from "../../src/sources/annas.js";
import { getBearerKey, param } from "./input.js";

/** GET ?md5=&tld= : a time-limited download URL, spending a credit of the caller's account. */
export default async function handler(req, res) {
  const key = getBearerKey(req);
  if (!key) {
    res.status(401).json({ error: "Anna's Archive key not set; add it in Settings." });
    return;
  }
  const md5 = param(req, "md5").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) {
    res.status(400).json({ error: "md5 must be 32 hex characters" });
    return;
  }
  try {
    const baseUrl = param(req, "tld") ? mirrorFor(param(req, "tld")) : undefined;
    res.status(200).json(await fastDownload(md5, key, { baseUrl }));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}
