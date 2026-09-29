# Resuming bookmark downloads

How to pick the unattended downloads (`scripts/scheduler.mjs`) back up after a
restart, crash, or power loss — by hand or with a local Claude Code agent.

## What survives a crash

Everything the scheduler needs is on disk in the repo folder:

| File | Holds | Crash behaviour |
| --- | --- | --- |
| `bookmarks-queue.json` | every book: pending / failed / done / moved | written atomically; previous version kept as `.bak` and used automatically if the main file is unreadable |
| `scheduler-state.json` | the batch slots | a slot missed while the Mac was off runs once on restart |
| `scheduler.log` | what happened, batch by batch | append-only |
| `scheduler.pid` | the running scheduler | stale after a crash; detected and ignored |
| `resume.local.env` | your paths and slots (never the key) | — |

In the download folder, a half-written `*.part` file is moved to `_invalid/` and
its book re-queued. A book that finished after the last queue save is
recognised by its md5 (with its `.txt`) at the next verification. Nothing that
was finished and verified is downloaded again. All of these files are
git-ignored.

## By hand

```bash
cd ~/annas-archive-api
git pull                       # latest code
scripts/resume.sh status       # where things stand
scripts/resume.sh start        # tests + verification, then the scheduler in the background
tail -f scheduler.log          # watch it (Ctrl+C only stops watching)
```

`start` asks for the Anna's Archive key (input hidden) unless `ANNAS_KEY` is
already set, refuses to start a second scheduler, and keeps running after the
terminal is closed. `scripts/resume.sh stop` stops it.

First time on a machine: `cp resume.local.env.example resume.local.env` and fill
it in (paths, slots, mirror TLD).

## With a local agent

Start Claude Code in the repo with the key in its environment, so the agent can
start the scheduler without ever seeing the key in a file or command:

```bash
cd ~/annas-archive-api
read -rsp "Anna's Archive key: " ANNAS_KEY; export ANNAS_KEY; echo
claude
```

Then give it this prompt:

> Resume the Anna's Archive bookmark downloads in this repo after a crash.
> Follow docs/RESUME.md. Steps:
> 1. `git status` and `git pull` (branch as checked out); don't commit or push anything.
> 2. Confirm `resume.local.env` exists and its paths exist; don't edit it unless a path is missing, then ask me.
> 3. Run `scripts/resume.sh status` and summarise: finished / to download / gave up, metadata coverage, scheduler running or not, missed and next slots, the last batch in `scheduler.log` and when the log stops (≈ time of the crash).
> 4. Run `scripts/resume.sh check`. It must end in `✅ ALL GREEN`. If not, explain each problem line and propose a fix before changing anything.
> 5. If green and the scheduler isn't running, run `scripts/resume.sh start` (ANNAS_KEY is in the environment — never print, echo, log or write it anywhere).
> 6. Wait ~30 s, then show the last 15 lines of `scheduler.log` and confirm the upcoming slots. If a missed slot is running a batch, report its progress.
> 7. Finish with: books finished vs. total, estimated finish date from the slots and recent batch sizes, and anything I need to do.

The agent never needs the key in a file: `resume.sh start` reads it from the
environment and the scheduler keeps it in memory only.

## Troubleshooting

- **`Missing resume.local.env`** — copy `resume.local.env.example` and fill it in.
- **`A scheduler is already running`** — it's fine; `scripts/resume.sh status` to see it, `stop` to stop it.
- **Verification not green** — the problem lines name the file and the reason; broken files are already moved to `_invalid/` and re-queued, so usually rerunning `check` is green.
- **"No fast downloads left" right after a restart** — the credits are still in their 18 h window; the next slot picks up. Nothing is lost.
- **Both `bookmarks-queue.json` and its `.bak` unreadable** — rare. Rename both aside and run `node scripts/queue-bookmarks.mjs <bookmarks.html>` then `--verify <download dir>`: books still in the folder are recognised by md5. Books already moved out of it would be queued again, so move them back first or accept re-downloads.
