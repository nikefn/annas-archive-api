/**
 * Anna's Archive: shadow-library search engine for books, papers and magazines.
 * Opt-in source; needs a member account key (ANNAS_KEY).
 *
 * What costs what:
 *   free    search, the file record (/db/...json, with name, size, content type,
 *           IPFS ids), SciDB pages for DOIs, IPFS gateways
 *   credit  a fast-download link (/dyn/api/fast_download.json); the daily quota
 *           is tracked in <library>/_state/annas.json
 * Free routes are tried first. Credited links are capped per work and run
 * (ANNAS_MAX_PER_WORK), and none is requested while the quota is used up.
 *
 * Searches and records need a signed-in session, because Anna's Archive sends
 * anonymous /search requests through a bot check. The key is exchanged for a
 * session cookie (POST /account/); only the cookie is kept, in memory, under a
 * hash of the key, and it is only ever sent to the mirror it came from. An
 * expired session gets a bot check; one fresh login is tried before giving up.
 *
 * The web UI in server/ uses search() and fastDownload() with a per-request key.
 */

import { createHash } from "node:crypto";

import { load } from "cheerio";

import { config } from "../config.js";
import { HttpError, client, hostOf, isOutage, mirrorSet } from "../http.js";
import * as store from "../store.js";

const http = client({ headers: { "Accept-Language": "en-US,en;q=0.9" } });
export const mirrors = mirrorSet(config.annasMirrors.map((m) => m.replace(/\/$/, "")));

const COUNT_LOOKUPS_IN_FLIGHT = 10;
const SESSION_TTL_MS = 6 * 3_600_000;
const REDIRECT_LIMIT = 5;
const GATEWAYS_PER_FILE = 3;

/** Raised when the site answers, but not with what was asked for. */
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
  if (!want || !base) {
    throw new AnnasArchiveError(`unknown mirror "${tld}"; allowed: ${mirrors.ordered().map(hostOf).join(", ")}`, 400);
  }
  return base;
}

const squash = (text) => text.replace(/\s+/g, " ").trim();
const UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** "0.4MB" -> bytes, else undefined. */
function sizeOf(field) {
  const m = field.match(/^(\d+(?:\.\d+)?)\s?([KMG])B$/i);
  return m ? Math.round(Number(m[1]) * UNITS[m[2].toUpperCase()]) : undefined;
}

/**
 * Results of a search page. Each result card holds a title link to /md5/<md5>
 * and a line "English [en] · EPUB · 0.4MB · 2014 · Book (fiction) · sources",
 * from which format, size and content type are read. The md5 must be 32 hex
 * characters because the UI puts it into its markup.
 */
export function parseSearchResults(html, baseUrl = config.annasMirrors[0]) {
  const $ = load(html);
  const base = baseUrl.replace(/\/$/, "");
  const seen = new Set();
  const results = [];
  $("a.js-vim-focus[href^='/md5/']").each((_, el) => {
    const link = $(el);
    const md5 = link.attr("href").slice("/md5/".length);
    if (!/^[a-f0-9]{32}$/.test(md5) || seen.has(md5)) return;
    seen.add(md5);
    const card = link.closest("div.flex.pt-3").length ? link.closest("div.flex.pt-3") : link.parent();
    const metaLine = card
      .find("div")
      .filter((__, d) => $(d).children("div").length === 0 && /·/.test($(d).text()) && /\d\s?[KMG]B\b/i.test($(d).text()))
      .last();
    const fields = squash(metaLine.text()).split("·").map((f) => f.trim());
    const type = fields.find((f) => /\b(book|article|magazine|comic|standard|score)\b/i.test(f));
    const cover = card.find("img").first().attr("src");
    results.push({
      title: squash(link.text()),
      author: squash(card.find("a:has(span[class*='user-edit'])").first().text()),
      format: fields.find((f) => /^[A-Z][A-Z0-9]{1,5}$/.test(f))?.toLowerCase() ?? null,
      size: fields.map(sizeOf).find(Boolean) ?? null,
      content_type: type ? type.replace(/^[^\p{L}]+/u, "").toLowerCase().replace(/\W+/g, "_").replace(/_+$/, "") : null,
      name: squash(card.find("div.font-mono").first().text()) || null,
      downloads: null,
      cover_url: cover ? new URL(cover, `${base}/`).toString() : null,
      url: `${base}/md5/${md5}`,
      md5,
    });
  });
  return results;
}

/** In-memory sessions, keyed by a hash of key and mirror: { cookie, since }. */
const sessions = new Map();
const sessionKey = (key, baseUrl) => createHash("sha256").update(`${key}\n${baseUrl}`).digest("hex");

/** Exchange the key for the site's session cookies (those named aa_*). */
async function login(baseUrl, key) {
  const resp = await http.request(`${baseUrl}/account/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key }).toString(),
    redirect: "manual",
  });
  await resp.body?.cancel();
  const pairs = [];
  for (const header of resp.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (/^aa_[^=]*=/.test(pair.trim())) pairs.push(pair.trim());
  }
  // A wrong key gets the login form again, without a cookie.
  if (!pairs.length) throw new AnnasArchiveError("Anna's Archive rejected the key; check it in Settings.", 401);
  return pairs.join("; ");
}

async function session(baseUrl, key, fresh = false) {
  const slot = sessionKey(key, baseUrl);
  const known = sessions.get(slot);
  if (known && !fresh && Date.now() - known.since < SESSION_TTL_MS) return known.cookie;
  const entry = { cookie: await login(baseUrl, key), since: Date.now() };
  sessions.set(slot, entry);
  return entry.cookie;
}

/** GET following redirects one by one; the cookie is dropped as soon as a hop leaves the mirror. */
async function getFollowing(url, cookie) {
  let current = new URL(url);
  const origin = current.origin;
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const headers = cookie && current.origin === origin ? { Cookie: cookie } : {};
    const resp = await http.request(current, { headers, redirect: "manual", totalMs: config.timeoutMs });
    const loc = resp.headers.get("location");
    if (resp.status < 300 || resp.status >= 400 || !loc) return { resp, url: current };
    await resp.body?.cancel();
    current = new URL(loc, current);
  }
  throw new AnnasArchiveError("too many redirects from Anna's Archive", 502);
}

/** A signed-in GET (anonymous without a key); a bot check gets one fresh login. */
async function signedIn(baseUrl, path, key) {
  for (const fresh of [false, true]) {
    try {
      return await getFollowing(`${baseUrl}${path}`, key && (await session(baseUrl, key, fresh)));
    } catch (err) {
      if (err.code !== "CHALLENGE" || !key || fresh) throw err;
    }
  }
}

async function page(baseUrl, path, key) {
  const { resp, url } = await signedIn(baseUrl, path, key);
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(`HTTP ${resp.status} (${hostOf(baseUrl)})`, resp.status);
  }
  return { body: await resp.text(), url };
}

/** Download counts come from a separate endpoint; a failed lookup leaves null. */
async function addDownloadCounts(results, baseUrl) {
  const queue = results.slice();
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const data = await http.json(`${baseUrl}/dyn/md5/inline_info/${r.md5}`).catch(() => null);
      const n = parseInt(data?.downloads_total, 10);
      r.downloads = Number.isNaN(n) ? null : n;
    }
  };
  await Promise.all(Array.from({ length: COUNT_LOOKUPS_IN_FLIGHT }, worker));
}

/** Up to `limit` results, with download counts unless `includeDownloads` is false. Without `baseUrl` the mirrors rotate. */
export async function search(query, { limit = 20, includeDownloads = true, key, baseUrl } = {}) {
  const once = async (base) => {
    const { body } = await page(base, `/search?${new URLSearchParams({ q: query })}`, key);
    const results = parseSearchResults(body, base).slice(0, limit);
    if (includeDownloads) await addDownloadCounts(results, base);
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
    const resp = await http.request(`${base}/dyn/api/fast_download.json?${new URLSearchParams({ md5, key })}`, {
      totalMs: config.timeoutMs,
    });
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

/** The PDF a SciDB page shows (its viewer's file= or a PDF link), or null. */
export function parseScidbPage(html, pageUrl) {
  const $ = load(html);
  const viewer = $("iframe[src*='viewer.html'], a[href*='viewer.html']").first();
  const viewerUrl = viewer.attr("src") ?? viewer.attr("href");
  const file = viewerUrl ? new URL(viewerUrl, pageUrl).searchParams.get("file") : $("a[href$='.pdf']").attr("href");
  return file ? new URL(file, pageUrl).toString() : null;
}

const records = new Map(); // md5 -> recordInfo

async function record(md5) {
  if (!records.has(md5)) {
    const info = await mirrors.run(async (base) => {
      const { body } = await page(base, `/db/aarecord_elasticsearch/md5:${md5}.json`, config.keys.annas);
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
    const refillAt = left > 0 ? null : new Date(Date.now() + config.annasWindowHours * 3_600_000).toISOString();
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
      files: [
        {
          md5: r.md5,
          format: r.format ?? undefined,
          size: r.size ?? undefined,
          name: r.name ?? undefined,
          contentType: r.content_type ?? undefined,
          credit: true,
        },
      ],
    }));
    return q.doi ? [{ meta: { doi: q.doi }, files: [{ scidb: q.doi }] }, ...found] : found;
  },

  /** The free file record; skipped while credits are used up, since no link could follow. */
  async describe(file) {
    if (!file.md5) return {};
    await credits.check();
    return record(file.md5);
  },

  async *links(file, { work, shared, allowCredit = true }) {
    const key = config.keys.annas;
    if (file.scidb) {
      const url = await mirrors.run(async (base) => {
        const scidb = await page(base, `/scidb/${file.scidb}`, key);
        return scidb.url.pathname.startsWith("/scidb/") ? parseScidbPage(scidb.body, scidb.url.toString()) : null;
      });
      if (url) yield { url };
      return;
    }
    await credits.check();
    // Without a readable record there are no gateway routes, but the credited link still works.
    const info = file.ipfs
      ? file
      : await record(file.md5).catch((err) => {
          if (isOutage(err)) throw err;
          return { ipfs: [] };
        });
    const failures = (g) => shared.failures.get(hostOf(g)) ?? 0;
    const gateways = [...config.ipfsGateways].sort((a, b) => failures(a) - failures(b)).slice(0, GATEWAYS_PER_FILE);
    for (const cid of info.ipfs.slice(0, 1)) {
      for (const gateway of gateways) yield { url: `${gateway.replace(/\/$/, "")}/ipfs/${cid}`, md5: file.md5 };
    }
    if (!allowCredit) return;
    const spent = shared.spent.get(work.id) ?? 0;
    if (spent >= config.annasMaxPerWork) return;
    await credits.check();
    shared.spent.set(work.id, spent + 1);
    yield { url: await creditedLink(file.md5), md5: file.md5, credit: true };
  },
};
