# Evaluation

Three layers, cheapest first. Run all three before merging a change to the
pipeline, the checks or a source.

## 1. Offline tests

```bash
npm test
```

The tests never leave the machine: `test/env.mjs` ends the process if anything
tries to reach a host other than 127.0.0.1. Sources and sites are stood in for
by small local HTTP servers, and documents are generated in memory. The suite
must be fully green.

## 2. Invariants

```bash
litfetch verify      # exit code 1 when one is broken
```

| Invariant | Broken means |
| --- | --- |
| The library is outside any git checkout, or git ignores it | downloads could be committed |
| Every kept file exists and still has its recorded sha256 | a file was lost or changed |
| No record holds a key, a credited download URL or session data | a secret was written to disk |

`verify` also lists works that hold the same file. That is a note, not an
error: the work that got the file second is in `review` with a `duplicate`
warning and can be closed.

## 3. Benchmark

`eval/set.tsv` lists works with the kind and language expected, and, where
someone has checked it by hand, the md5 of a correct file (`gold`). It is a
seed of 26 works. The target is 200: 100 books (60 English, 20 French
originals, 20 German originals, 20 of them multi-volume), 80 articles (40 with
an open-access copy, 40 without) and 20 grey-literature reports, with gold for
at least 50.

Run it in a library of its own, on the same machine and within the same day for
every version compared, with Anna's Archive credits reset or accounted for:

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
| yield | works with a kept file, of all not closed | up by 15 points over the previous release |
| passed every check | works in `done` | report |
| credited links per file kept from credits | Anna's fast-download links handed out per file they produced | 1.2 or lower |
| excerpt rejects per 100 book downloads | book downloads rejected by `length` or `printout` | down 80 % after excerpt ordering |
| repeat downloads | the same file downloaded twice for the same work | 0 |
| waiting on an outage | works that will be retried within hours | report; an outage never counts as a try |
| median seconds per work | wall time of each work's last run | report |
| gold | kept files whose md5 equals the gold md5 | report |

The wrong-file rate needs a person: open 50 randomly chosen `done` works and
check the title page, the author and the volume. The target is 1 wrong file
in 50 or fewer.
