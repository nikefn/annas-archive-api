# litfetch

litfetch keeps a queue of works and fetches a checked copy of each. A work can
be given as a DOI, arXiv ID, ISBN, PMID, PMCID, URL, UN document symbol, EU
CELEX number, Anna's Archive md5, or a plain title or citation. litfetch asks
every configured source for it, downloads candidate files in a fixed order and
checks each one: is the file intact, is it the work that was asked for, does
the metadata from different sources agree. Files and their records go into one
folder per work.

Sources, in the default order:

- web pages: a URL you give, or the page a DOI resolves to, read through the
  `citation_*` meta tags most journals and repositories carry
- Crossref, OpenAlex (needs a free key), Unpaywall (needs a contact email),
  Open Library, arXiv, Europe PMC, Semantic Scholar, CORE, HAL, Zenodo
- grey literature: World Bank documents, DSpace repositories such as WHO IRIS
  and FAO, UN documents by symbol, EU law and publications (CELLAR)
- opt-in: OpenAIRE (rate-limited), and the shadow libraries Anna's Archive
  and Library Genesis

[docs/sources.md](docs/sources.md) describes each source and how to get its
key.

Node 22.13 or later, no build step, no database.

## Quick start

```bash
npm install
cp .env.example .env               # then set LITFETCH_EMAIL in it
npm link                           # once; afterwards `litfetch` works anywhere
litfetch add 10.1371/journal.pone.0115253 arXiv:1706.03762 "symbol: A/RES/70/1"
litfetch add -f references.bib     # or .ris, .tsv, or a text file with one work per line
litfetch run
litfetch status
litfetch export > library.ris      # Zotero, Mendeley and EndNote import it with the files
```

| Command | Does |
| --- | --- |
| `add <input...> [-f file]` | Queue works from the arguments or a file. |
| `run [id...]` | Process the works that are due, or exactly the ones named. |
| `status` | Count works per status; say why each `review`, `waiting` and `not_found` work is there. |
| `show <id>` | Print one work record. |
| `retry <id...>` or `retry --status <s>` | Queue works again now. |
| `close <id...>` | Stop retrying works. |
| `recheck [id...]` | Run the checks again on kept files, without downloading. |
| `find <input>` | Ask the sources and print what they return; queue nothing. |
| `sources` | Show which sources are active and what the others need. |
| `export` | Print the library as RIS; each `L1` line attaches the file. |
| `stats` | Print the evaluation metrics ([docs/eval.md](docs/eval.md)). |
| `verify` | Check the library's invariants; exit code 1 if one is broken. |

Input forms: `10.xxxx/...` or a doi.org link, `arXiv:2101.00001` or an arXiv
link, an ISBN (checksum verified), `pmid: 12345678`, `PMC1234567`,
`md5: <32 hex>`, `celex: 32016R0679`, `symbol: A/RES/70/1`, any http(s) URL.
Anything else is treated as a title or citation. Imported BibTeX and RIS
entries use their DOI, else a valid ISBN, else the URL, else the title; title,
authors, year, entry type and language go along as hints. A language hint makes
a file in another language fail.

## How a work is processed

1. Every active source is asked at once. A candidate counts when it shares an
   identifier with the work or its title matches: the same title, another
   edition (different subtitle), or a longer title containing it. A different
   volume or part number never matches. An identifier whose record fits
   neither the title nor the authors is not trusted. If the answers reveal an
   identifier or a title the input lacked, all answers are matched again and
   the sources that returned nothing are asked once more.
2. The metadata is merged: each field comes from the first source that has it,
   in `LITFETCH_SOURCES` order, and identifiers you typed win.
3. Candidate files are downloaded one by one, at most `LITFETCH_MAX_ATTEMPTS`
   per run, in this order: free files before files that may cost a download
   credit, then by how well the title matched, then by source order. For a
   book, files that look like excerpts (a PDF under 1 MB, or a file the source
   labels as a journal article) come last, and a journal-article file never
   gets a credited link.
4. Each file goes through the file checks below. The first file that passes
   them all ends the search. If none passes, the first that only warned is
   kept. A file that failed is remembered by md5 and not downloaded again for
   that work; a download that broke on the way (wrong md5, cut off) is not
   remembered.
5. A kept file is only replaced by a strictly better one, and the old file
   moves to `_replaced/`.

| Status | Meaning | Next run |
| --- | --- | --- |
| `queued` | new, or queued again with `retry` | the next `run` |
| `done` | a file is kept and every check passed | only after `retry` |
| `review` | a file is kept, at least one check warned | only after `retry` |
| `waiting` | no file yet because a source was down, answered with a bot check, or had no credits left; this does not count as a try | after 6, 12, 24 and 72 hours, then weekly, or when credits return |
| `not_found` | no source had an acceptable file | after 1, 3, 7 and 14 days, then every 30 days |
| `closed` | set with `close` | never |

Requests to each host are spaced by a per-host pace (`src/config.js`). A
download stops after 60 s without data, below 20 KB/s once 2 minutes have
passed, or after 20 minutes. Bot checks are recognised and never worked
around: a source that answers with one is paused for the rest of the run, and
a file behind one counts as unavailable.

## Quality checks

The checks are defined in [`src/checks/rules.js`](src/checks/rules.js). File
checks judge a downloaded file: a `fail` rejects it and stops its checks.
Work checks judge the merged metadata and are the same for every file. A work
is `done` when the kept file and the work pass every check, otherwise
`review`.

| Check | Pass | Warn | Fail |
| --- | --- | --- | --- |
| `format` | PDF, EPUB, DjVu or MOBI, judged by the bytes | | anything else, e.g. an HTML or JSON error page |
| `opens` | parses (PDF with pdf.js, EPUB through its package file) | | corrupt, encrypted, or cut off (no `%%EOF`, no end of ZIP directory) |
| `drm` | | | EPUB content encrypted, or `rights.xml` present |
| `hash` | md5 matches the one the source listed | | md5 differs |
| `duplicate` | no other work holds the same file | another work holds it | |
| `text-layer` | about 100 characters of text per page or more | a scan without OCR, or a format whose text is not read | |
| `identity` | DOI on page 1 or 2, or 80 % of the title's words found | 50 to 80 %, or no text to compare | under 50 % in a readable text |
| `author` | first author's surname found | not found | |
| `length` | at least half the expected pages; without an expected count, 40 for a book and 2 for an article | | fewer |
| `printout` | | | for a book: a chapter printed from an online platform ("Page n of N") |
| `language` | the language the work asks for | | another language |
| `metadata-complete` (work) | title, authors and year present | something missing | |
| `metadata-agreement` (work) | every source's title matches; years differ by 1 at most | a source disagrees | |
| `retraction` (work) | | marked retracted by Crossref or OpenAlex | |

Model triage is off by default. With `LITFETCH_LLM_MODELS` and
`ANTHROPIC_API_KEY` set, a file whose `identity` check warned has its opening
pages sent to the Anthropic API, and a model answers match, mismatch or
unsure. The models are asked in the listed order, and "unsure" passes the
question to the next one. A document could be written to sway that answer,
so triage only ever settles a warning.

## The library

```
~/litfetch-library/                  LITFETCH_LIBRARY
  index.csv                          one row per work, rebuilt after each change
  works/doi-10.1371-journal.pone.0115253/
    work.json                        the record: input, status, metadata, checks, attempts
    smith-2014-title-of-the-paper.pdf
  _replaced/<work-id>/               files a better one replaced
  _state/annas.json                  Anna's Archive credits left
```

`work.json` is the only source of truth for a work, including its place in the
queue. litfetch refuses a library inside a git checkout unless git ignores it,
and commands that change existing works take a lock so two cannot overlap.
Records never contain keys or signed download links; `litfetch verify` checks
that, too.

## Web UI

```bash
npm run ui     # http://127.0.0.1:3000
```

A page to search Anna's Archive, open a member download link, or queue a
result. It listens on this machine only unless `LITFETCH_UI_HOST` says
otherwise. Queueing needs the token set in `LITFETCH_UI_TOKEN`. The Anna's
Archive key is kept in the browser and sent to the server with each request;
the server never stores it and only sends it to the mirrors in
`ANNAS_MIRRORS`.

| Endpoint | Does |
| --- | --- |
| `GET /api/search?query=&limit=&downloads=&tld=` | search results as JSON (needs the key) |
| `GET /api/download?md5=&tld=` | a time-limited download URL (needs the key) |
| `POST /api/queue` with `{ input, title?, authors? }` | queue a work (needs the token) |

## Docker

The image keeps the library in `/library` and serves the UI on port 3000. It
runs as the user `node` (uid 1000), so the folder mounted as the library must
be writable for that uid. Publish the port on this machine only:

```bash
docker build -t litfetch .
docker run --rm -p 127.0.0.1:3000:3000 -v "$HOME/litfetch-library:/library" --env-file .env litfetch
docker run --rm -v "$HOME/litfetch-library:/library" --env-file .env litfetch node src/cli.js run
```

## Contributing

`npm test` must pass and runs offline. [CLAUDE.md](CLAUDE.md) maps the code
and its rules, and [docs/eval.md](docs/eval.md) describes how changes are
measured.

## Legal

The sources on by default serve open-access or public documents. Shadow
libraries host copyrighted material, and using them is illegal in many
countries; they stay off unless added to `LITFETCH_SOURCES`, and their use is
the user's responsibility.

## Credits

litfetch started as a fork of
[bitesized/annas-archive-api](https://github.com/bitesized/annas-archive-api),
a search page and download proxy for Anna's Archive. That project's history is
kept in this repository; its code has since been replaced.

## License

MIT, see [LICENSE](LICENSE). The license covers the code in this repository,
not the documents litfetch downloads.
