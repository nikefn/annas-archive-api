# litfetch — agent guide

Queue → find → download → verify literature from open-access, grey-literature
and opt-in shadow-library sources. Node 22.13+, ESM, no build step.

## Commands

```bash
npm install
npm test                         # offline: no network, no keys
node src/cli.js <command>        # or `npm link` once, then `litfetch <command>`
npm run ui                       # web UI at http://localhost:3000
```

## Map

```
src/config.js        every setting (env / .env) — nothing else reads process.env
src/http.js          every network request: UA, timeout, retries, per-source spacing
src/ids.js           input line → query; query → work id; slugs
src/text.js          normalise / similarity — the one definition of "matches"
src/store.js         library on disk; work.json is the single source of truth
src/pipeline.js      gather → merge → download → check → keep best
src/download.js      stream to disk with md5 + sha256, size cap
src/checks/rules.js  the quality standard (all checks, thresholds, verdict rule)
src/checks/file.js   format detection by bytes; PDF/EPUB text extraction
src/checks/llm.js    optional model triage of uncertain identity checks
src/sources/*.js     one adapter per source; interface in sources/index.js
src/export.js        RIS export (attaches files in reference managers)
src/cli.js           commands
server/              web UI (search Anna's Archive, download, queue)
test/                offline tests; documents are generated, not stored
docs/sources.md      every source: what it holds, credentials, limits
library/             content (git-ignored), never code
```

## Invariants

- Code and content stay apart: nothing under `library/` is code; nothing in the repo is content.
- A file's format is decided by its bytes (`detectFormat`), never by URL or Content-Type.
- Every downloaded file passes through `checks/rules.js`; status follows from the verdict only.
- Keys are read from config only, never logged, and redacted from URLs saved in records.
  The web server never uses env keys: it takes the Anna's Archive key per request
  (`Authorization: Bearer`) and keeps only a hashed-key session cookie in memory.
- Network-dependent tests are not allowed. Adapters export pure mappers
  (`toCandidate`, `parse…`) and those are what the tests exercise.
- Public repository: no personal data, names, emails or local paths in code, docs or fixtures.

## Adding a source

1. `src/sources/<id>.js`: default export `{ id, name, missing(), find(q), resolve? }`
   (contract in `src/sources/index.js`). Use `client({ minIntervalMs })` from `http.js`
   at the source's published rate limit. Return `[]` for queries it cannot serve.
2. Register it in `src/sources/index.js`; add it to `DEFAULT_SOURCES` in
   `src/config.js` only if it is open and keyless-or-free.
3. New setting → `src/config.js` + `.env.example`.
4. A test for its mapper in `test/sources.test.mjs`; a row in `docs/sources.md`.

## When something changes, update

| Change                         | Also update                         |
| ------------------------------ | ----------------------------------- |
| check added/removed/threshold  | README "Quality checks" table       |
| setting added/renamed          | `.env.example`                      |
| source added/changed access    | `docs/sources.md`                   |
| record shape (`work.json`)     | header comment in `src/store.js`    |

## Model triage

For agents working on this repo:

| Model  | Use for |
| ------ | ------- |
| Haiku  | Mechanical edits: renames, docs wording, mapper tweaks from a known response shape, running tests |
| Sonnet | A new source adapter, bug fixes, test additions, CLI commands |
| Opus   | Changes to `checks/rules.js`, `pipeline.js` or `store.js`, record-shape changes, security-sensitive code (keys, server) |

In the pipeline, `LITFETCH_LLM_MODELS` applies the same ladder: the cheapest model
answers first, "unsure" escalates. It only runs when the identity check warned
and `ANTHROPIC_API_KEY` is set.
