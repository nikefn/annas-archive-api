# litfetch

litfetch takes a list of works and keeps them in a queue until it has a good
copy of each. A work can be given as a DOI, arXiv ID, ISBN, PMID, URL, UN
document symbol, EU CELEX number, or a plain title or citation. For each one it
asks every configured source, downloads candidates in a fixed order, and checks
every file: that it is intact, that it is the work asked for, and that the
metadata from different sources agrees. Files and their records go into one
folder per work.

Sources on by default: Crossref, OpenAlex, Unpaywall, arXiv, Europe PMC,
Semantic Scholar, CORE, HAL, Zenodo, the World Bank, WHO, FAO and other DSpace
repositories, UN documents, the EU Publications Office, and any web page with
the usual `citation_*` meta tags (most journals and repositories), including
the landing page a DOI resolves to. Opt-in: OpenAIRE (rate-limited) and the
shadow libraries Anna's Archive and Library Genesis.

Node 22.13 or later, no build step, no database.

## Quick start

```bash
npm install
cp .env.example .env               # set LITFETCH_EMAIL at least
npm link                           # once; or use: node src/cli.js
litfetch add 10.1371/journal.pone.0115253 arXiv:1706.03762 "symbol: A/RES/70/1"
litfetch add -f references.bib     # also .ris, .tsv, or one item per line
litfetch run
litfetch status
litfetch export > library.ris      # Zotero, Mendeley and EndNote import it with the files
```

`litfetch sources` shows which sources are active and what the others need;
[docs/sources.md](docs/sources.md) explains how to get each key.

| Command | Does |
| --- | --- |
| `add <input...> [-f file]` | Queue works, from arguments or a list, BibTeX, RIS or TSV file. |
| `run [id...]` | Process the works that are due, or exactly the ones named. |
| `status` | Counts per status, and why each `review`, `waiting` and `not_found` work is there. |
| `show <id>` | Print one work record. |
| `retry <id...>` or `retry --status <s>` | Queue works again now. |
| `close <id...>` | Stop retrying works. |
| `recheck [id...]` | Run the checks again on kept files, without downloading. |
| `find <input>` | Ask the sources, queue nothing. |
| `sources` | Active sources and missing settings. |
| `export` | RIS on stdout; each `L1` line attaches the file. |
| `stats` | Evaluation metrics, see [docs/eval.md](docs/eval.md). |
| `verify` | Check the library's invariants; exit code 1 if one is broken. |

Imported entries use their DOI as input when they have one, otherwise a valid
ISBN, the URL or the title. Title, authors, year, type (book, article, report)
and language go along as hints. A language hint makes a file in another
language fail.

## How a work is processed

1. Every active source is asked at once. If the answers reveal an identifier
   or a title the input lacked, the sources that found nothing are asked again
   with it. A candidate counts when it shares an identifier with the work or
   its title matches: the same title, another edition (different subtitle), or
   a longer title that contains it. A different volume or part number never
   matches, and an identifier whose record fits neither the title nor the
   authors is not trusted.
2. One metadata record is merged: each field comes from the first source that
   has it, in `LITFETCH_SOURCES` order, and identifiers typed by the user win.
3. Candidate files are downloaded in order, at most `LITFETCH_MAX_ATTEMPTS` per
   run: free files before files that may cost a download credit, then by how
   well the title matched, then by source order. For a book, files that look
   like excerpts (a PDF under 1 MB, or a file the source labels a journal
   article) come last, and a journal-article file never gets a credited link.
4. Every downloaded file goes through the checks below. The first file that
   passes is kept. If none passes, the first that only warned is kept.
5. A kept file is only ever replaced by a strictly better one, and the old file
   moves to `_replaced/`.

| Status | Meaning | Next run |
| --- | --- | --- |
| `queued` | new, or queued again with `retry` | next `run` |
| `done` | a file is kept and every check passed | only with `retry` |
| `review` | a file is kept, at least one check warned | only with `retry` |
| `waiting` | no file yet because a source was down, challenged with a bot check, or out of credits; not counted as a try | after a few hours, or when credits return |
| `not_found` | no source had an acceptable file | after 1, 3, 7 and 14 days, then every 30 days |
| `closed` | set with `close` | never |

A file whose content was rejected is remembered by md5 for that work and not
downloaded again. A download that broke on the way (wrong md5, cut off) is
tried again next time.

Requests to each host are spaced (`src/config.js`, e.g. 3 s for arXiv, 2 s for
Library Genesis); downloads stop after 60 s without data, below 20 KB/s once 2
minutes have passed, or after 20 minutes. Bot checks are recognised and never
worked around: a source that answers with one is paused for the rest of the
run, and a file behind one counts as unavailable.

## Quality checks

All checks live in [`src/checks/rules.js`](src/checks/rules.js). A `fail`
rejects the file and stops the checks; a `warn` sends the work to review.

| Check | Pass | Warn | Fail |
| --- | --- | --- | --- |
| `format` | PDF, EPUB, DjVu or MOBI, judged by the bytes | | anything else, e.g. an HTML or JSON error page |
| `opens` | parses (PDF with pdf.js, EPUB through its package file) | | corrupt, encrypted, or cut off (no `%%EOF`, no end of ZIP directory) |
| `drm` | | | EPUB content encrypted, or `rights.xml` present |
| `hash` | md5 matches the source's | | md5 differs |
| `duplicate` | no other work has the same file | another work has it | |
| `text-layer` | about 100 characters of text per page or more | scan without OCR, or a format whose text is not read | |
| `identity` | DOI on page 1 or 2, or 80 % of the title's words found | 50 to 80 %, or no text to compare | under 50 % with a readable text |
| `author` | first author's surname found | not found | |
| `length` | at least half the expected pages; without an expected count, 40 for a book, 2 for an article | | fewer |
| `printout` | | | a book work, but the file is a chapter printed from an online platform ("Page n of N") |
| `language` | the language the work asked for | | another language |
| `metadata-complete` | title, authors and year present | something missing | |
| `metadata-agreement` | all sources' titles match; years agree within 1 | a source disagrees | |
| `retraction` | | marked retracted by Crossref or OpenAlex | |

When `identity` warns and model triage is switched on (`LITFETCH_LLM_MODELS`
and `ANTHROPIC_API_KEY`), the opening pages are sent to the Anthropic API and a
model decides match, mismatch or unsure. The models are asked in the listed
order, cheapest first, and "unsure" goes to the next one. It is off by default.

## The library

```
~/litfetch-library/                 LITFETCH_LIBRARY
  index.csv                         one row per work, rebuilt after each command
  works/doi-10.1371-journal.pone.0115253/
    work.json                       the record: query, status, metadata, checks, attempts
    smith-2014-title-of-the-paper.pdf
  _replaced/<work-id>/              files a better one replaced
  _state/annas.json                 Anna's Archive credits left
```

`work.json` is the only source of truth for a work, its queue state included.
litfetch refuses to use a library inside a git checkout unless git ignores it.
Records never contain keys or signed download links; `litfetch verify` checks
that.

## Web UI

```bash
npm run ui     # http://127.0.0.1:3000
```

The UI from the original project: search Anna's Archive, get a member
fast-download link, or queue a result in the library. It listens on loopback
unless `LITFETCH_UI_HOST` says otherwise. The Queue button needs the token set
in `LITFETCH_UI_TOKEN`. The Anna's Archive key stays in the browser's
`localStorage` and goes to the server per request as `Authorization: Bearer`;
the server never stores it, and only sends it to the mirrors in
`ANNAS_MIRRORS`.

| Endpoint | Does |
| --- | --- |
| `GET /api/search?query=&limit=&downloads=&tld=` | search results as JSON (key required in practice) |
| `GET /api/download?md5=&tld=` | a time-limited download URL (key required) |
| `POST /api/queue` with `{ input, title?, authors? }` | queue a work (token required) |

## Docker

```bash
docker build -t litfetch .
docker run --rm -p 127.0.0.1:3000:3000 -v "$HOME/litfetch-library:/library" --env-file .env litfetch
docker run --rm -v "$HOME/litfetch-library:/library" --env-file .env litfetch node src/cli.js run
```

## Legal

The sources on by default serve open-access or public documents. Shadow
libraries host copyrighted material, and using them is illegal in many
countries; they stay off unless added to `LITFETCH_SOURCES`, and their use is
the user's responsibility.

## Credits

Forked from [bitesized/annas-archive-api](https://github.com/bitesized/annas-archive-api),
whose Anna's Archive client and web UI live on in `src/sources/annas.js` and
`server/`.
