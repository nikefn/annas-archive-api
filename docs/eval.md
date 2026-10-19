# Evaluation

A change to the pipeline, the checks or a source is evaluated in three steps,
from the cheapest to the most expensive. Run all three before merging it.

## 1. Offline tests

```bash
npm test
```

The tests never use the network. `test/env.mjs` ends the test process when code
calls `fetch()` for a host other than this machine. Sources and sites are stood
in for by small local HTTP servers, and documents are generated in memory. The
suite must pass in full.

## 2. Invariants

```bash
litfetch verify      # exit code 1 when one is broken
```

| Invariant | Broken means |
| --- | --- |
| The library is outside any git checkout, or git ignores it | downloads could be committed |
| Every kept file exists and still has its recorded sha256 | a file was lost or changed |
| No record holds a key, a credited download URL or session data | a secret was written to disk |

`verify` also lists works that hold the same file and folders without a
readable `work.json`. Neither breaks an invariant. Two works with one file are
usually the same work queued twice, and one of them can be closed.

## 3. Benchmark

`eval/set.tsv` lists 28 works with the kind and language expected: articles
with and without an open-access copy, public-domain and openly licensed books
in English, French and German, two multi-volume works, and grey-literature
reports. A `gold` column holds the md5 of a correct file once someone has
checked one by hand. New works should keep that mix.

Run the set in a library of its own, on the same machine and on the same day
for every version compared, with Anna's Archive credits reset or accounted for:

```bash
export LITFETCH_LIBRARY=~/litfetch-eval
litfetch add -f eval/set.tsv
litfetch run
litfetch stats
litfetch verify
```

`litfetch stats` reports:

| Metric | Meaning | Target |
| --- | --- | --- |
| yield | works with a kept file, of all not closed | no lower than the version compared against |
| passed every check | works in `done`, of all not closed | no lower than the version compared against |
| credited links per file kept from credits | Anna's Archive download links handed out per kept file that came from one | 1.2 or lower |
| excerpt rejects per 100 book downloads | book downloads rejected by `length` or `printout` | no higher than the version compared against |
| repeat downloads | the same file downloaded twice for the same work | 0 |
| waiting on an outage | works in `waiting` | none after a second run a day later |
| median seconds per work | wall time of each work's last run | no more than 1.5 times the version compared against |
| gold | kept files whose md5 equals the gold md5 | all |

The rate of wrong files needs a person: open 20 randomly chosen `done` works
and check the title page, the author and the volume. No wrong file is the
target.
