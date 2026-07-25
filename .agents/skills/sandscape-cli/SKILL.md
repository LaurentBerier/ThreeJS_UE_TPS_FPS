---
name: sandscape-cli
description: >-
  Drive the Sandscape CLI to work on a Sandscape game project locally — pull the
  latest, edit code and assets with your own tools, push changes back, import
  your own game, or publish. AI asset generation stays on the Sandscape platform.
  Use this whenever you are in a folder containing a `.sandscape/` directory, or
  when the user mentions Sandscape, cloning/pulling/pushing a game project, or the
  `sandscape` command.
allowed-tools: Bash(sandscape *), Bash(npx @sandscape/cli *)
---

# Sandscape CLI

This folder is a **local clone of a Sandscape game**. You edit code and assets
locally with your own tools; the Sandscape platform owns AI asset generation and
the coin/subscription model. Your job is the local edit loop: **pull → edit →
push**.

## Getting started (first run)

This skill is **instructions only** — it does not put a `sandscape` binary on
PATH. Invoke the CLI through npx. Every example below is written as bare
`sandscape …` for brevity; read that as `npx -y @sandscape/cli@latest …` (or a
real `sandscape` if the user installed one globally — they're interchangeable).
So `sandscape pull` means `npx -y @sandscape/cli@latest pull`. Having this skill
loaded means the guidance is present, **not** that anything ran: actually run the
CLI; do not report the setup as "already done" and stop.

**1. Check whether this machine is already authorized — don't re-login blindly.**
Probe cheaply and only log in if the probe says you're not:

```bash
npx -y @sandscape/cli@latest list --json
```

- Exit **0** → already authorized. Skip login entirely and go to *Once authorized:
  pick the next step* (the printed project list is also your answer for that step).
- Exit **1** with a "Not authorized" message → run step 2.

**2. Authorize (only if step 1 said you're not).** Login blocks until the user
approves in their browser, so run it in the **background** and read its events
from a file — never wait on it in the foreground:

```bash
LOG="${TMPDIR:-/tmp}/sandscape-login.jsonl"
npx -y @sandscape/cli@latest login --json > "$LOG" 2>&1 &
LOGIN_PID=$!
```

  a. Poll `$LOG` until its first line appears — a `{"event":"verification", …}`
     object. Show the user `verification_uri_complete` as a clickable link (fall
     back to `verification_uri` + `user_code`) and ask them to open it and approve.
  b. Then `wait "$LOGIN_PID"`. Exit **0** → the last line is
     `{"event":"authorized", …}`; you're in. Exit **1** → the last line is
     `{"event":"error", …}`; tell the user, then re-run to retry.

Once authorized the scoped token is stored on the machine and every other command
works with no further prompts.

## Once authorized: pick the next step

Look at the current folder and choose — don't stop at "logged in":

- **Has a `.sandscape/` directory** → it's already a Sandscape clone. Run
  `sandscape pull`, then work the **Core loop** below.
- **A game folder NOT yet on Sandscape** (no `.sandscape/`) → offer to **import**
  it with `sandscape init` (see *Importing your own game*). Import creates a new
  project on the user's account, so confirm with them first.
- **Empty or unrelated folder** → the user likely wants an existing project:
  `sandscape list` to see them, then `sandscape clone <session_id> <dir>`.

State which case you detected and the single command you'll run next.

## How this folder maps to the platform

This directory **is** the game's served root (`generated_assets/` on the
platform). Files can live anywhere under it — there is no required structure. The
only special file is **`index.html` at the root** (the served entry point).
Everything except the CLI-managed metadata below round-trips to the platform
verbatim.

CLI-managed — never the game's content, don't push or treat as game files:

- `.sandscape/` — session id, versions, file manifest, and the durable design.
- `CLAUDE.md` / `AGENTS.md` — generated guides.
- `.claude/`, `.agents/` — this skill (and other tool config).

The durable, agent-readable game design (concept, style, assets, plan) lives in
**`.sandscape/design.json`**. Read it first to understand what the project is.

## Core loop

1. **`sandscape pull`** — refresh from the platform before you start. Reject-on-
   divergence: if it refuses because the server advanced over a local edit, do NOT
   force blindly. `--force` **discards the user's local edits** to the conflicting
   files, so first tell the user exactly which files would be lost and get their OK
   (or copy those files aside as a backup). Only then run `sandscape pull --force`.
2. **Edit** files locally with your normal tools.
3. **`sandscape push`** — upload changed/new files. Reject-on-divergence: if the
   server moved past your base_version, run `sandscape pull` first, then push
   again. Pushing never merges — it rejects so you resolve explicitly.

## Asset generation routes through the platform

You **cannot** generate AI assets (3D models, images, audio) locally — that stays
on Sandscape because it is coin-metered. To add or regenerate a generated asset,
the user does it in the Sandscape web app, then you `sandscape pull` to bring it
down. You CAN freely edit code and hand-authored files locally and push them.

## Importing your own game (init)

`sandscape init <folder>` maps the folder tree **verbatim** into a new project,
so exclude everything that isn't game content FIRST. init honors `.gitignore`
and `.sandscapeignore` at the folder root, and always skips `node_modules/` and
`.git/`. Before you run it:

1. **If there is no `.gitignore`, create one.** Exclude build output and dev
   cruft: `node_modules/`, `dist/`, `build/`, `.next/`, `out/`, `coverage/`,
   `*.log`, `.DS_Store`, `.playwright-mcp/`, and any tmp/scratch dirs.
2. **Keep** the real game AND its source material — concept art, references, raw
   models, audio, the design doc (`gdd.md` / `ARCHITECTURE.md`). Sandscape wants
   those; they are not cruft. The CLI deliberately respects `.gitignore`, so if
   one of these important files is currently gitignored, update/negate that rule
   before init or push; otherwise the file will stay local and will not sync.
3. Want git to keep a file but Sandscape to skip it? Put it in
   `.sandscapeignore` (same syntax) instead of `.gitignore`.
4. **Ask the user whether to backfill — it costs coins, so get their OK first.**
   In plain terms: backfill has the AI read the imported game and fill in
   Sandscape's design — the concept, art style, asset descriptions, and the plan —
   so you can keep building the game **on Sandscape** with the AI, instead of it
   being just a stored copy of your files. It spends coins (that's the AI doing
   the work). If they say **yes**, run `sandscape init <folder> --backfill`: it
   prints the exact coin cost and their current balance, and spends **nothing** if
   the balance is too low. If they say **no / not sure**, run plain
   `sandscape init <folder>` — the import is free; the design just starts sparse
   and they can enrich it later in the Sandscape app.

init prints how many paths it excluded — check that summary before continuing so
you know the cut was right (e.g. `node_modules/` gone, `assets/` and `reference/`
kept).

**Closed-alpha gate.** Anyone can create a Sandscape account, but creating/
importing games is gated. If `init` reports something like *"Game creation is
currently in closed alpha — your account is on the list"*, that is NOT an error to
retry: the user is signed in but hasn't been granted creator access yet. Tell them
they're on the waitlist and can import once access is unlocked; don't loop on it.

## Commands

Add `--json` to any command for machine-readable, line-delimited output you can
parse (including progress events) instead of human text.

- `sandscape login` — authorize this machine once (device-code flow). Required
  before anything else. With `--json` it emits `verification` then `authorized`/
  `error` events — see **Getting started** above for the hands-off background flow.
- `sandscape logout` — forget the stored credentials on this machine (revoke the
  token server-side from the Sandscape account UI).
- `sandscape pull [--force]` — download the latest version. `--force` overwrites
  local edits on conflicting files — confirm with the user first (see Core loop).
- `sandscape push` — upload your local changes.
- `sandscape list` — list the user's projects (id, name, status). Also the
  cheap auth probe: exit 0 = authorized, exit 1 = needs `login`.
- `sandscape publish --title "<title>"` — publish the game (**public-facing** —
  confirm the title and that they want it live before running). The server
  rebuilds from its own bundle and re-validates; the CLI only sends metadata.
- `sandscape clone <session_id> [dir]` — clone another of the user's projects
  into a new folder.
- `sandscape init <folder> [--name <n>] [--backfill]` — import the user's OWN
  game folder as a new Sandscape project. Maps the folder tree verbatim (honoring
  `.gitignore`/`.sandscapeignore`, always skipping `node_modules/` + `.git/` — see
  *Importing your own game*) and auto-registers recognized asset files for FREE.
  `--backfill` runs an OPTIONAL coin-metered pass that enriches design metadata —
  it prints the cost and the user's balance first and you should confirm before
  spending coins.

## Liveness

Long operations (clone/pull/push) emit per-file progress, and with `--json` emit
`{"event":"progress","done":N,"total":M,"path":"..."}` lines, so you can tell
"working" from "stalled" during big transfers.

For full flags, exit codes, the version/divergence model, and `--json` event
shapes, see [reference.md](reference.md).
