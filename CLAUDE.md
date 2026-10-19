# litfetch: agent guide

litfetch keeps a queue of works and fetches a checked copy of each, from
open-access, grey-literature and opt-in shadow-library sources. Node 22.13+,
ESM, no build step. What it does for a user is in README.md; this file is about
working on the code.

## Commands

```bash
npm install
npm test                         # offline; a test that calls fetch() for another host ends the run
node src/cli.js <command>        # or `npm link` once, then `litfetch <command>`
node src/cli.js verify           # library invariants
npm run ui                       # web UI at http://127.0.0.1:3000
```

## Map

```
src/config.js        every setting, validated, and the per-host pace table
src/http.js          requests: UA, timeouts, retries, pacing, bot-check detection, isOutage(), mirrors
src/download.js      stream to disk with md5 + sha256; stall, rate, total and size limits
src/ids.js           input line -> query; query -> work id; slugs
src/text.js          normalise, titleMatch (tiers, volumes), language detection and codes
src/rank.js          work kind; order of candidate files; excerpt signals
src/store.js         library on disk: work.json per work, _replaced/, _state/, lock, git guard
src/pipeline.js      gather -> merge -> try files -> keep best -> settle status and next try
src/checks/rules.js  the quality standard: file checks, work checks, thresholds, verdict
src/checks/index.js  checks one downloaded file (file rules plus optional triage)
src/checks/file.js   format by bytes; PDF and EPUB reading (text, DRM, truncation)
src/checks/llm.js    opt-in model triage of uncertain identity checks
src/sources/*.js     one adapter per source; the contract is in sources/index.js
src/imports.js       BibTeX, RIS, TSV and plain lists -> inputs with hints
src/audit.js         verify (invariants) and stats (evaluation metrics)
src/export.js        RIS export
src/cli.js           commands
server/              web UI (index.js, api/ handlers, public/ page, script, styles)
test/                offline tests; documents built in memory, sites stood in for by local servers
docs/sources.md      every source: holdings, credentials, limits
docs/eval.md         how changes are measured
eval/set.tsv         benchmark works
```

The library (default `~/litfetch-library`) holds content only and never lives
inside the repository.

## Invariants

- A kept file is never deleted. Only a strictly better file (pass beats warn on
  the file checks) replaces it, and the old one moves to `_replaced/`.
- A file's format comes from its bytes, never from its URL or Content-Type.
- Every downloaded file goes through the file checks; a work's status follows
  from its checks and from `settle()` in `pipeline.js`.
- A failure from a source's API that `isOutage()` calls temporary (5xx, 429,
  timeouts, network errors, bot checks, no credits) never counts as a try. A
  file URL that answers with a bot check or a refusal counts as unavailable.
- Keys come from config only and are never logged or stored. Records keep a
  file's listed URL, never a link produced by `links()` (those can be signed).
  The web server takes the Anna's Archive key per request and never uses env keys.
- No test may need the network.
- Public repository: no personal data, names, emails or local paths in code,
  docs, fixtures or commits.

## Adding a source

1. `src/sources/<id>.js`: default export `{ id, name, missing(), find(q) }`,
   plus `links()` when download URLs must be looked up or signed, and
   `describe()` when file details cost a separate free call. Mark files that
   may spend a paid credit with `credit: true`. Throw temporary failures; a
   source that swallows them turns an outage into a try.
2. Register it in `src/sources/index.js`. Add it to `DEFAULT_SOURCES` in
   `src/config.js` only if it is open and free; add its host to the pace table
   if its limit is stricter than one request per second.
3. Export the response mappers and test them in `test/sources.test.mjs`.
4. Describe it in `docs/sources.md`; new settings go in `src/config.js` and
   `.env.example`.

## One owner per fact

| Fact | Owner | Also mentioned in |
| --- | --- | --- |
| checks, thresholds, verdict | `src/checks/rules.js` | README "Quality checks" |
| statuses and retry gaps | `src/pipeline.js` | README "How a work is processed" |
| settings and defaults | `src/config.js` | `.env.example` (commented) |
| default sources and pace | `src/config.js` | README intro, `docs/sources.md` |
| input forms | `src/ids.js` | README, CLI help |
| `work.json` fields | header of `src/store.js` | none |
| metrics | `src/audit.js` | `docs/eval.md` |

Change the owner first, then every place in the last column.

## Model choice for agents

| Model | Use for |
| --- | --- |
| Haiku | mechanical edits: renames, wording, a mapper fix for a known response shape, running tests |
| Sonnet | a new source adapter, bug fixes, tests, CLI commands |
| Opus | `checks/rules.js`, `pipeline.js`, `store.js`, `http.js`, record-shape changes, keys and the server |

Model triage inside the pipeline works the same way: `LITFETCH_LLM_MODELS`
lists models cheapest first, and an "unsure" answer goes to the next.
