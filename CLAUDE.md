# Sandscape Project — Local Clone

This directory is a local clone of Sandscape session `session_20260722_abd1bec4e410c9a8e51ee0858b8c1751`
(cloned at base_version `4`).

## Where the design lives

The cleaned, durable game design context is in:

    .sandscape/design.json

This is the **durable-keys** snapshot of the session context — the canonical,
agent-readable description of the game (concept, style, assets, etc.). It is the
source of truth for what the project *is*. Read it before making changes.

## Layout

This directory **is** the game's `generated_assets/` root. Put files wherever
you like — there is no required structure. The only special file is
`index.html` at this root, which is the served entry point.

- `.sandscape/`   — CLI metadata (project/design/manifest); never uploaded.
- `CLAUDE.md` / `AGENTS.md` — these guides; never uploaded.
- everything else (`index.html`, `src/`, `assets/`, audio, models, ...) is your
  game and round-trips to `generated_assets/` verbatim.

## Round-trip

Every file under this directory (except the CLI metadata above) syncs to the
session's `generated_assets/` at the same relative path: a top-level
`index.html` becomes `generated_assets/index.html`, a `src/main.js` becomes
`generated_assets/src/main.js`, your own `assets/img.png` becomes
`generated_assets/assets/img.png`. (Internally each path is sent with a
one-segment `assets/` transport prefix that the server strips — you never see
it; just work with normal paths here.)

## Using the CLI

Run these from this directory:

- `sandscape pull`            — refresh from the server (delta download, SHA256
  verified). Rejects if the server advanced and your local edits would be
  overwritten; re-run with `--force` to let the server win.
- `sandscape push`            — upload your local edits. Reject-on-divergence:
  if the server advanced past your `base_version`, `pull` first, then push.
  Each file is limited to **50 MB**; one push is limited to **500 MB / 5,000
  files**. Both `.gitignore` and `.sandscapeignore` are respected: a gitignored
  asset/reference will not sync, so update `.gitignore` if it belongs in the
  game. Put additional intentionally local files in `.sandscapeignore`.
- `sandscape list`            — list your projects (`--json` for scripts).
- `sandscape publish --title "<t>"` — publish to the platform (the **server**
  re-validates and builds from its own bundle; the CLI only sends metadata).

All transfer commands accept `--json` for line-delimited progress events so
agentic tools can detect working-vs-stalled.

## AGENTS.md

`AGENTS.md` mirrors this file so agent tooling that looks for either name finds
the same guide. On POSIX it is a symlink to `CLAUDE.md`; on platforms where
symlink creation is not permitted (e.g. some Windows setups) it is written as a
small pointer file that points back to `CLAUDE.md`.
