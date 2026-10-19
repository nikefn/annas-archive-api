# litfetch: agent guide

Queue, find, download and verify literature from open-access, grey-literature
and opt-in shadow-library sources. Node 22.13+, ESM, no build step.

## Commands

```bash
npm install
npm test                         # offline; the suite fails if anything leaves 127.0.0.1
node src/cli.js <command>        # or `npm link` once, then `litfetch <command>`
node src/cli.js verify           # library invariants
npm run ui                       # web UI at http://127.0.0.1:3000
```

## Map

```
src/config.js        every setting (env / .env) and the per-host pace table; nothing else reads process.env
src/http.js          every network request: UA, header timeout, retries, pacing, bot-check
                     detection, isOutage(), mirror rotation
src/download.js      stream to disk with md5 + sha256; stall, rate, total and size limits
src/ids.js           input line -> query; query -> work id; slugs
src/text.js          normalise, similarity, titleMatch (tiers, volumes), language detection
src/rank.js          work kind; order of candidate files; excerpt signals
src/store.js         library on disk (work.json per work, _replaced/, _state/), git guard
src/pipeline.js      gather -> merge -> try files -> keep best -> settle status and next try
src/checks/rules.js  the quality standard: every check, threshold and the verdict rule
src/checks/file.js   format by bytes; PDF and EPUB reading (text, DRM, truncation)
src/checks/llm.js    opt-in model triage of uncertain identity checks
src/sources/*.js     one adapter per source; the interface is documented in sources/index.js
src/imports.js       BibTeX, RIS, TSV and plain lists -> inputs with hints
src/audit.js         verify (invariants) and stats (evaluation metrics)
src/export.js        RIS export
src/cli.js           commands
server/              web UI: search Anna's Archive, download, queue
test/                offline tests; documents generated in memory, sites stood in for by local servers
docs/sources.md      every source: holdings, credentials, limits
docs/eval.md         how changes are evaluated
eval/set.tsv         benchmark works
```

The library (default `~/litfetch-library`) holds content only and is never
inside the repository.

## Invariants

- A kept file is never deleted. It is replaced only by a strictly better file
  (pass beats warn) and then moved to `_replaced/`.
- A file's format comes from its bytes, never from its URL or Content-Type.
- Every downloaded file goes through `checks/rules.js`; the status follows from
  the verdict and from `settle()` in `pipeline.js`.
- An outage (`isOutage()`: 5xx, 429, timeouts, network errors, bot checks, no
  credits) never counts as a try.
- Keys come from config only and are never logged or stored. Records store a
  file's listed URL, never a link that `links()` produced (those can be signed).
  The web server takes the Anna's Archive key per request and never uses env keys.
- No test may need the network.
- Public repository: no personal data, names, emails or local paths in code,
  docs, fixtures or commits.

## Adding a source

1. `src/sources/<id>.js`: default export `{ id, name, missing(), find(q) }`,
   plus `links()` when download URLs must be looked up or signed, and
   `describe()` when file details cost a separate free call (contract in
   `src/sources/index.js`). Mark files that may spend a paid credit with
   `credit: true`.
2. Register it in `src/sources/index.js`. Add it to `DEFAULT_SOURCES` in
   `src/config.js` only if it is open and free; add its host to the pace table
   if its rate limit is stricter than one request per second.
3. Export the response mappers and test them in `test/sources.test.mjs`.
4. Document it in `docs/sources.md`; new settings go in `src/config.js` and
   `.env.example`.

## Keep in step

| Change | Also update |
| --- | --- |
| a check, threshold or status | README tables |
| a setting | `.env.example` |
| a source or its access | `docs/sources.md` |
| a `work.json` field | header comment of `src/store.js` |
| a metric | `docs/eval.md` and `src/audit.js` |

## Model triage

For agents working on this repository:

| Model | Use for |
| --- | --- |
| Haiku | mechanical edits: renames, wording, a mapper fix for a known response shape, running tests |
| Sonnet | a new source adapter, bug fixes, tests, CLI commands |
| Opus | `checks/rules.js`, `pipeline.js`, `store.js`, `http.js`, record-shape changes, keys and the server |

Inside the pipeline the same ladder applies through `LITFETCH_LLM_MODELS`
(opt-in): the cheapest model answers first and "unsure" escalates.
