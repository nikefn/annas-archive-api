# litfetch

Give it a list of works (DOIs, arXiv IDs, ISBNs, URLs, UN document symbols,
CELEX numbers, or plain titles and citations). It keeps them in a queue, asks
every configured source for a copy, downloads the best candidate, and checks
that the file is intact, is the work you asked for, and that its metadata is
consistent. Everything ends up in a plain folder you can browse.

It covers scholarly open access (Crossref, OpenAlex, Unpaywall, arXiv, Europe
PMC, Semantic Scholar, CORE, HAL, Zenodo) and grey literature (World Bank, WHO
IRIS and other DSpace repositories, UN documents, EU Publications Office).
Shadow libraries (Anna's Archive, Library Genesis) are optional and off by
default. Any landing page that carries standard `citation_*` meta tags also
works, which covers most institutional repositories.

Node 22.13+, no build step, no database.

## Quick start

```bash
npm install
cp .env.example .env          # set LITFETCH_EMAIL at least
node src/cli.js add 10.1371/journal.pone.0115253 arXiv:1706.03762 "symbol: A/RES/70/1"
node src/cli.js add -f reading-list.txt     # one item per line, # for comments
node src/cli.js run
node src/cli.js status
node src/cli.js export > library.ris        # import into Zotero, Mendeley, EndNote
```

Run `npm link` once to use `litfetch` instead of `node src/cli.js`. Use
`litfetch sources` to see which sources are active and which settings the
others need. `docs/sources.md` explains how to get each credential.

| Command | Does |
| --- | --- |
| `add <input…> [-f file]` | Queue works. |
| `run [id…]` | Process queued works, or only the ids given. |
| `status` | Counts per status, plus the reason for each `review` and `failed` work. |
| `show <id>` | Print one work record. |
| `retry [id…] [--failed] [--review]` | Put works back in the queue. |
| `recheck [id…]` | Re-run the checks on files already kept, without downloading. |
| `find <input>` | Ask the sources without queueing anything. |
| `sources` | Show which sources are active. |
| `export` | Write RIS to stdout. The `L1` field attaches each file on import. |

## How a work is processed

1. **Gather.** Every active source is asked at the same time. If the answers
   reveal new identifiers (say, a DOI for a title), sources that found nothing
   are asked once more. A candidate is kept if it shares an identifier with the
   work, or if its title matches the input.
2. **Merge.** One metadata record is built. Each field comes from the first
   source that has it, in `LITFETCH_SOURCES` order, and identifiers you typed
   always win.
3. **Download and check.** Candidate files are tried in source order, up to
   `LITFETCH_MAX_ATTEMPTS`. A file that fails a check is deleted and the next
   one is tried. The first file that passes everything is kept. If none passes,
   the first file that only got warnings is kept instead.

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for `run`. |
| `done` | A file is kept and every check passed. |
| `review` | A file is kept, but at least one check warned. `status` shows which. |
| `failed` | No candidate produced an acceptable file. `error` says why. |

## Quality checks

The checks are defined in [`src/checks/rules.js`](src/checks/rules.js). A
`fail` rejects the file, a `warn` sends the work to review.

| Check | Pass | Warn | Fail |
| --- | --- | --- | --- |
| `format` | PDF, EPUB, DjVu or MOBI, judged by the file's bytes | | anything else, e.g. an HTML login page |
| `opens` | parses (PDF via pdf.js, EPUB via its package file) | | corrupt, truncated (no `%%EOF`) or encrypted |
| `hash` | md5 matches the one the source reported | | md5 differs |
| `duplicate` | no other work has the same sha256 | same file as another work | |
| `text-layer` | about 100+ characters of text per page | scan without OCR, or a format whose text isn't read | |
| `identity` | DOI printed on page 1–2, or ≥ 80 % of title words found | 50–80 %, or no text to compare | < 50 % with a readable text layer |
| `author` | first author's surname found | not found | |
| `length` | page count ≥ 50 % of the expected count | | fewer pages (preview or partial) |
| `metadata-complete` | title, authors and year present | something missing | |
| `metadata-agreement` | sources agree on title (≥ 70 % similar) and year (± 1) | a source disagrees | |
| `retraction` | | marked retracted by Crossref or OpenAlex | |

Every file also gets an md5 and a sha256 in its record. When a warning comes
from `identity` and `ANTHROPIC_API_KEY` is set, a model reads the opening pages
and confirms or rejects the file. The cheapest model in `LITFETCH_LLM_MODELS`
answers first, and an "unsure" answer escalates to the next one.

## The library

```
library/
  index.csv                                   one row per work (rebuilt after each command)
  works/doi-10.1371-journal.pone.0115253/
    work.json                                 the record: query, status, metadata, checks, attempts
    smith-2014-title-of-the-paper.pdf
```

`work.json` is the only source of truth for a work, its queue state included.
Moving or backing up `library/` keeps everything. A record looks like this
(trimmed):

```json
{
  "id": "doi-10.1371-journal.pone.0115253",
  "input": "10.1371/journal.pone.0115253",
  "status": "done",
  "meta": { "title": "…", "authors": ["…"], "year": 2014, "doi": "10.1371/journal.pone.0115253" },
  "file": { "name": "….pdf", "format": "pdf", "bytes": 812345, "md5": "…", "sha256": "…",
            "source": "europepmc", "url": "…", "version": "publishedVersion", "license": "cc-by" },
  "checks": [{ "name": "identity", "status": "pass", "detail": "DOI printed in document" }],
  "attempts": [{ "source": "europepmc", "url": "…", "verdict": "pass" }],
  "candidates": [{ "source": "crossref", "meta": { … }, "files": [] }],
  "lookups": [{ "source": "crossref", "found": 1 }]
}
```

## Web UI

```bash
npm run ui     # http://localhost:3000
```

This UI comes from the original project. It searches Anna's Archive and
proxies its member fast download. A **Queue** button on each result adds it to
the library, ready for `litfetch run`. The Anna's Archive key lives in the
browser's `localStorage` and is sent per request as `Authorization: Bearer`.
The server never stores it and has no fallback to an environment key. The
member key is sent to whichever mirror is configured, so check the domain
first: retired mirrors get re-registered by third parties.

| Endpoint | Does |
| --- | --- |
| `GET /api/search?query=&limit=&downloads=&tld=` | Scrape Anna's Archive search results into JSON. Needs the key. |
| `GET /api/download?md5=&tld=` | Resolve an md5 to a time-limited download URL. Needs the key. |
| `POST /api/queue` `{ input, title?, authors? }` | Queue a work in the library. |

## Docker

```bash
docker build -t litfetch .
docker run --rm -p 3000:3000 -v "$PWD/library:/library" --env-file .env litfetch                    # UI
docker run --rm -v "$PWD/library:/library" --env-file .env litfetch node src/cli.js run         # CLI
```

## Legal

Sources that are on by default serve open-access or public documents. Shadow
libraries host copyrighted material, and accessing them is illegal in many
countries. They stay off unless you add them to `LITFETCH_SOURCES`, and using
them is your responsibility. Respect each source's terms and rate limits.
`src/http.js` spaces requests per source to stay within them.

## Credits

This project is forked from
[bitesized/annas-archive-api](https://github.com/bitesized/annas-archive-api),
whose Anna's Archive client and web UI it still uses
(`src/sources/annas.js`, `server/`).
