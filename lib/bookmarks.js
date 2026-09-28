/**
 * Browser bookmark export (Netscape `bookmarks.html`) → Anna's Archive md5s.
 *
 * Every browser exports the same loose format: a folder is `<DT><H3>name</H3>`
 * followed by a `<DL>` holding its children, and `<DT>` is never closed. That
 * is not valid enough for a DOM parser to nest reliably, so this walks the tags
 * in order and keeps a folder stack instead. Pure, no network.
 */

const TAG = /<(\/?)(h3|dl|a)\b([^>]*)>([^<]*)/gi;
const MD5_PATH = /^\/md5\/([a-f0-9]{32})\/?$/i;
const ANNAS_HOST = /(^|\.)annas-archive\.[a-z]+$/i;

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return every link with the folder path it sits in (outermost first). */
export function parseBookmarks(html) {
  const links = [];
  const stack = [];
  let pendingFolder = null;

  for (const [, closing, tag, attrs, text] of html.matchAll(TAG)) {
    const name = tag.toLowerCase();
    if (name === "h3" && !closing) {
      pendingFolder = decodeEntities(text);
    } else if (name === "dl") {
      if (closing) {
        stack.pop();
      } else {
        // The root <DL> has no heading; keep it on the stack as null so the
        // matching </DL> pops the right entry.
        stack.push(pendingFolder);
        pendingFolder = null;
      }
    } else if (name === "a" && !closing) {
      const href = attrs.match(/\bhref\s*=\s*"([^"]*)"/i)?.[1];
      if (href) {
        links.push({
          url: decodeEntities(href),
          title: decodeEntities(text),
          folders: stack.filter((f) => f !== null),
        });
      }
    }
  }
  return links;
}

/** The md5 of an Anna's Archive `/md5/<hash>` link on any mirror, else null. */
export function annasMd5(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !ANNAS_HOST.test(parsed.hostname)) {
    return null;
  }
  return parsed.pathname.match(MD5_PATH)?.[1].toLowerCase() ?? null;
}

/**
 * Pick the links inside folders whose name matches `folderPattern` (at any
 * depth, subfolders included) and split them into queueable md5s and the rest.
 * Duplicates across folders are queued once, under the first folder seen.
 */
export function collectQueue(html, folderPattern) {
  const queue = [];
  const skipped = [];
  const seen = new Set();

  for (const link of parseBookmarks(html)) {
    const idx = link.folders.findIndex((f) => folderPattern.test(f));
    if (idx === -1) continue;
    const folder = link.folders.slice(idx).join("/");
    const md5 = annasMd5(link.url);
    if (!md5) {
      skipped.push({ folder, title: link.title, url: link.url, reason: "not an Anna's Archive /md5/ link" });
    } else if (seen.has(md5)) {
      skipped.push({ folder, title: link.title, url: link.url, reason: "duplicate" });
    } else {
      seen.add(md5);
      queue.push({ md5, title: link.title, folder, url: link.url, status: "pending" });
    }
  }
  return { queue, skipped };
}
