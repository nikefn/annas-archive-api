/**
 * Anna's Archive: shadow-library search engine for books, papers and magazines.
 * Opt-in source; needs a member account secret key (ANNAS_KEY).
 *
 * What costs what:
 *   free    search, the file record (/db/...json, with name, size, content type,
 *           IPFS ids), SciDB pages for DOIs, IPFS gateways
 *   credit  a fast-download link (/dyn/api/fast_download.json); the daily quota
 *           is tracked in <library>/_state/annas.json
 * Free routes are tried first. Credited links are capped per work and pass
 * (ANNAS_MAX_PER_WORK), and none is requested while the quota is used up.
 *
 * Searches and records need a signed-in session: Anna's Archive sends anonymous
 * /search and /md5/ requests through a DDoS-Guard check that fetch cannot pass.
 * The key is traded for a session cookie via POST /account/, and only that
 * cookie is cached, in memory, under a hash of the key. An expired session gets
 * a redirect loop with check=1, which http.js reports as a bot check; one fresh
 * login is tried before giving up.
 *
 * The web UI in server/ uses search() and fastDownload() with a per-request key.
 */

import { createHash } from "node:crypto";

import { load } from "cheerio";

import { config } from "../config.js";
import { HttpError, client, hostOf, isOutage, mirrorSet } from "../http.js";
import * as store from "../store.js";

const HEADERS = { "Accept-Language": "en-US,en;q=0.9" };
const http = client({ headers: HEADERS });
export const mirrors = mirrorSet(config.annasMirrors.map((m) => m.replace(/\/$/, "")));

const DOWNLOAD_COUNT_CONCURRENCY = 10; // inline_info lookups in flight; a politeness cap
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
const GATEWAYS_PER_FILE = 3;
const HOUR = 3_600_000;

/** sha256(key + mirror) -> { cookie, at }. In memory only, never persisted. */
const sessions = new Map();

/** Raised when the upstream site answers but not with what was asked for. */
export class AnnasArchiveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AnnasArchiveError";
    this.status = status;
  }
}

/** The configured mirror whose domain ends in `.tld`; anything else is refused. */
export function mirrorFor(tld) {
  const want = String(tld).trim().replace(/^\.+/, "").toLowerCase();
  const base = mirrors.ordered().find((m) => hostOf(m).endsWith(`.${want}`));
  if (!want || !base) throw new AnnasArchiveError(`unknown mirror "${tld}"; allowed: ${mirrors.ordered().map(hostOf).join(", ")}`, 400);
  return base;
}

function clean(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pull the file format out of the metadata line, e.g.
 *   "English [en] · EPUB · 0.4MB · 2014 · 📕 Book (fiction) · 🚀/lgli/..."
 * Format is the short token before the file size (epub, pdf, azw3, fb2, ...). We
 * scan segments rather than hard-coding an index so an extra leading field
 * doesn't break it.
 *
 * Digits are allowed after the first character so alphanumeric extensions
 * (fb2, azw3, mp3) are recognised, but the token must start with a letter,
 * which keeps the year ("2014") and the size ("0.4MB") from matching.
 */
function extractFormat(metaText) {
  for (const seg of metaText.split("·").map((s) => s.trim())) {
    const token = seg.toLowerCase();
    const stripped = token.replace(/-/g, "");
    // Short tokens only; skip language-ish "[xx]" segments.
    if (stripped && /^\p{L}[\p{L}\d]*$/u.test(stripped) && token.length <= 6) {
      if (seg.includes("[")) continue;
      return token;
    }
  }
  return null;
}

/** Fallback: locate the metadata line by its emoji/middot signature. */
function findMetaDiv($, card) {
  let found = null;
  card.find("div").each((_, el) => {
    if (found) return;
    const div = $(el);
    const text = div.text();
    const hasSignature =
      text.includes("📕") ||
      text.includes("📘") ||
      text.includes("📗") ||
      text.includes("MB") ||
      text.includes("KB");
    if (text.includes("·") && hasSignature && div.find("div").length === 0) {
      // Prefer the most specific (deepest) matching div.
      found = div;
    }
  });
  return found;
}

/** Extract all search results from a search page's HTML. */
export function parseSearchResults(html, baseUrl = config.annasMirrors[0]) {
  const $ = load(html);
  const base = baseUrl.replace(/\/$/, "");
  const results = [];

  // Each result's title is an anchor carrying the `js-vim-focus` class and
  // pointing at /md5/<hash>, the most stable anchor on the card.
  $("a.js-vim-focus[href^='/md5/']").each((_, el) => {
    const titleLink = $(el);
    const href = titleLink.attr("href") || "";
    const md5 = href.split("/").pop();
    // Drop anything that isn't a real 32-hex md5: the value is mirror-controlled
    // and flows into a JS-string sink in the frontend download button.
    if (!/^[a-f0-9]{32}$/.test(md5)) return;
    const title = clean(titleLink.text());

    // Walk up to the result card so author/meta lookups stay scoped to it.
    let card = titleLink;
    for (let i = 0; i < 6; i++) {
      const parent = card.parent();
      if (parent.length === 0) break;
      card = parent;
      if (card.hasClass("flex") && card.hasClass("pt-3")) break;
    }

    // Author: the anchor whose icon is `mdi--user-edit`.
    let author = "";
    const authorIcon = card.find("span[class*='icon-[mdi--user-edit]']").first();
    if (authorIcon.length) {
      const authorLink = authorIcon.closest("a");
      if (authorLink.length) author = clean(authorLink.text());
    }

    // Cover image inside the cover thumbnail div (some results have none).
    let coverUrl = null;
    const coverImg = card
      .find("div[id^='list_cover_aarecord_id__'] img")
      .first();
    if (coverImg.length) {
      const src = coverImg.attr("src");
      if (src) {
        coverUrl = src.startsWith("http")
          ? src
          : `${base}/${src.replace(/^\//, "")}`;
      }
    }

    // Metadata line (language · FORMAT · size · year · type · sources).
    let metaDiv = card
      .find("div.font-semibold.text-sm")
      .filter((__, d) => ($(d).attr("class") || "").includes("leading-[1.2]"))
      .first();
    if (!metaDiv.length) metaDiv = findMetaDiv($, card);
    const format = metaDiv && metaDiv.length ? extractFormat(metaDiv.text()) : null;

    results.push({
      title,
      author,
      format,
      downloads: null,
      cover_url: coverUrl,
      url: `${base}/md5/${md5}`,
      md5,
    });
  });

  return results;
}

const sessionId = (key, baseUrl) => createHash("sha256").update(`${key}\n${baseUrl}`).digest("hex");

/**
 * Exchange the account secret key for a session cookie. Anna's Archive takes a
 * single form field (`key`) on POST /account/ and replies with an
 * `aa_account_id2` cookie; anything starting `aa_` is session state.
 */
async function login(baseUrl, key) {
  const resp = await http.request(`${baseUrl}/account/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key }).toString(),
    redirect: "manual",
  });
  await resp.body?.cancel();
  const cookie = resp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith("aa_") && c.includes("="))
    .join("; ");
  // A bad key still returns 200 with the login form, just no session cookie.
  if (!cookie) throw new AnnasArchiveError("Anna's Archive rejected the key; check it in Settings.", 401);
  return cookie;
}

async function session(baseUrl, key, fresh = false) {
  const id = sessionId(key, baseUrl);
  const hit = sessions.get(id);
  if (!fresh && hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.cookie;
  const cookie = await login(baseUrl, key);
  sessions.set(id, { cookie, at: Date.now() });
  return cookie;
}

/** GET following redirects by hand, so a check=1 hop is reported, not looped on. */
async function getFollowing(url, headers) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await http.request(current, { headers, redirect: "manual" });
    const loc = resp.headers.get("location");
    if (resp.status < 300 || resp.status >= 400 || !loc) return { resp, url: current };
    await resp.body?.cancel();
    current = new URL(loc, current);
  }
  throw new AnnasArchiveError("too many redirects from Anna's Archive", 502);
}

/** A signed-in GET (anonymous without a key). A bot check gets one fresh login. */
async function signedIn(baseUrl, path, key) {
  for (const fresh of [false, true]) {
    const headers = key ? { Cookie: await session(baseUrl, key, fresh) } : {};
    try {
      return await getFollowing(`${baseUrl}${path}`, headers);
    } catch (err) {
      if (err.code !== "CHALLENGE" || !key || fresh) throw err;
    }
  }
}

async function text(baseUrl, path, key) {
  const { resp, url } = await signedIn(baseUrl, path, key);
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(`HTTP ${resp.status} (${hostOf(baseUrl)})`, resp.status);
  }
  return { body: await resp.text(), url };
}

/** Fill result.downloads from inline_info; a failed lookup leaves null. */
async function fetchDownloads(result, baseUrl) {
  try {
    const data = await http.json(`${baseUrl}/dyn/md5/inline_info/${result.md5}`, { headers: { Accept: "text/css" } });
    const n = parseInt(data.downloads_total, 10);
    result.downloads = Number.isNaN(n) ? null : n;
  } catch {
    result.downloads = null;
  }
}

async function withConcurrency(items, limit, worker) {
  const queue = items.slice();
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    })
  );
}

/**
 * Search and return up to `limit` results, with download counts unless
 * `includeDownloads` is false. Without `baseUrl` the mirrors are rotated.
 */
export async function search(query, { limit = 20, includeDownloads = true, key, baseUrl } = {}) {
  const once = async (base) => {
    const { body } = await text(base, `/search?${new URLSearchParams({ q: query })}`, key);
    const results = parseSearchResults(body, base).slice(0, limit);
    if (includeDownloads) await withConcurrency(results, DOWNLOAD_COUNT_CONCURRENCY, (r) => fetchDownloads(r, base));
    return results;
  };
  return baseUrl ? once(baseUrl) : mirrors.run(once);
}

/**
 * One fast-download link for an md5, spending a credit of the key's account.
 * The key has to go in the query string here; that URL is never stored or logged.
 */
export async function fastDownload(md5, key, { baseUrl } = {}) {
  const once = async (base) => {
    const resp = await http.request(`${base}/dyn/api/fast_download.json?${new URLSearchParams({ md5, key })}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new AnnasArchiveError(data.error || `HTTP ${resp.status}`, resp.status);
    return data;
  };
  return baseUrl ? once(baseUrl) : mirrors.run(once);
}

/** Name, size, format, content type and IPFS ids from a file record. */
export function recordInfo(record) {
  const u = record?.file_unified_data ?? {};
  return {
    name: u.original_filename_best || undefined,
    size: Number(u.filesize_best) || undefined,
    format: u.extension_best || undefined,
    contentType: u.content_type_best || undefined,
    ipfs: (u.ipfs_infos ?? []).map((i) => i.ipfs_cid).filter(Boolean),
  };
}

/** The PDF a SciDB page shows (its viewer's file= or the download link), or null. */
export function parseScidbPage(html, pageUrl) {
  const $ = load(html);
  const viewer = $("iframe[src*='viewer.html'], a[href*='viewer.html']").first();
  const viewerUrl = viewer.attr("src") ?? viewer.attr("href");
  const file = viewerUrl ? new URL(viewerUrl, pageUrl).searchParams.get("file") : $("a[href$='.pdf']").attr("href");
  return file ? new URL(file, pageUrl).toString() : null;
}

const records = new Map();

async function record(md5) {
  if (!records.has(md5)) {
    const info = await mirrors.run(async (base) => {
      const { body } = await text(base, `/db/aarecord_elasticsearch/md5:${md5}.json`, config.keys.annas);
      return recordInfo(JSON.parse(body));
    });
    records.set(md5, info);
  }
  return records.get(md5);
}

/** Download credits of ANNAS_KEY's account, persisted between runs. */
const credits = {
  async check() {
    const s = await store.readState("annas");
    if (s?.left === 0 && Date.parse(s.refillAt) > Date.now()) {
      const err = new HttpError(`no fast-download credits until ${s.refillAt}`, 0, "NO_CREDITS");
      err.retryAt = s.refillAt;
      throw err;
    }
  },
  async note(left) {
    const refillAt = left > 0 ? null : new Date(Date.now() + config.annasWindowHours * HOUR).toISOString();
    await store.writeState("annas", { left, refillAt, updated: new Date().toISOString() });
  },
};

async function creditedLink(md5) {
  const data = await mirrors.run(async (base) => {
    try {
      return await fastDownload(md5, config.keys.annas, { baseUrl: base });
    } catch (err) {
      if (err.status !== 429) throw err;
      await credits.note(0);
      await credits.check();
      throw err;
    }
  });
  const left = data.account_fast_download_info?.downloads_left;
  if (Number.isInteger(left)) await credits.note(left);
  if (!data.download_url) throw new AnnasArchiveError(data.error || "no download_url", 502);
  return data.download_url;
}

/** Source adapter. */
export default {
  id: "annas",
  name: "Anna's Archive",
  missing: () => (config.keys.annas ? [] : ["ANNAS_KEY"]),

  async find(q) {
    if (q.md5) return [{ meta: { md5: q.md5 }, files: [{ md5: q.md5, credit: true }] }];
    const term = q.doi || q.isbn || q.title;
    if (!term) return [];
    const results = await search(term, { limit: 10, includeDownloads: false, key: config.keys.annas });
    const found = results.map((r) => ({
      meta: { title: r.title, authors: r.author ? [r.author] : [], md5: r.md5 },
      files: [{ md5: r.md5, format: r.format, credit: true }],
    }));
    return q.doi ? [{ meta: { doi: q.doi }, files: [{ scidb: q.doi }] }, ...found] : found;
  },

  /** The free file record; skipped while credits are used up, since no link could follow. */
  async describe(file) {
    if (!file.md5) return {};
    await credits.check();
    return record(file.md5);
  },

  async *links(file, { work, pass, allowCredit = true }) {
    const key = config.keys.annas;
    if (file.scidb) {
      const url = await mirrors.run(async (base) => {
        const page = await text(base, `/scidb/${file.scidb}`, key);
        return new URL(page.url).pathname.startsWith("/scidb/") ? parseScidbPage(page.body, page.url.toString()) : null;
      });
      if (url) yield { url };
      return;
    }
    await credits.check();
    // Without a readable record there are no gateway routes, but the credited link still works.
    const info = file.ipfs ? file : await record(file.md5).catch((err) => {
      if (isOutage(err)) throw err;
      return { ipfs: [] };
    });
    const failures = (g) => pass.failures.get(hostOf(g)) ?? 0;
    const gateways = [...config.ipfsGateways].sort((a, b) => failures(a) - failures(b)).slice(0, GATEWAYS_PER_FILE);
    for (const cid of info.ipfs.slice(0, 1)) {
      for (const gateway of gateways) yield { url: `${gateway.replace(/\/$/, "")}/ipfs/${cid}`, md5: file.md5 };
    }
    if (!allowCredit) return;
    const spent = pass.spent.get(work.id) ?? 0;
    if (spent >= config.annasMaxPerWork) return;
    await credits.check();
    pass.spent.set(work.id, spent + 1);
    yield { url: await creditedLink(file.md5), md5: file.md5, credit: true };
  },
};
