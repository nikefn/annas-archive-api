/** Reading request input safely; every handler goes through these. */

/** The Anna's Archive key from `Authorization: Bearer <key>`, never from the environment. */
export function getBearerKey(req) {
  const match = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** A query parameter as one trimmed string ("" when missing; the first value when repeated). */
export function param(req, name) {
  const value = req.query[name];
  return String(Array.isArray(value) ? value[0] : value ?? "").trim();
}
