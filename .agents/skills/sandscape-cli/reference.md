# Sandscape CLI — reference

Full command reference for `@sandscape/cli`. The skill body (SKILL.md) covers the
workflow; this file is the detail you reach for when a command misbehaves.

## Auth & configuration

- `sandscape login` runs the device-code flow (RFC 8628): it prints a
  verification URL and a short user code; the user opens the URL, signs in (or
  creates a free account right there), and authorizes the code. The CLI polls until approved, then stores a scoped,
  revocable token in the user's home config (managed by the CLI — do not
  hand-edit). Tokens can be revoked from the Sandscape account UI.
- Backend selection:
  - `SANDSCAPE_API_URL` selects the backend when `login` runs without
    `--api-url`; the chosen origin is stored with the token.
  - `--api-url <url>` is an explicit, authenticated override for a trusted
    debug or alternate backend. A cross-origin override warns before the request.
  - Without the flag, project metadata cannot silently change the login origin
    (scheme, hostname, or port) and redirect credentials.
  - `SANDSCAPE_WEB_URL` (or `--web-url`) — web origin used to print the play URL
    after `publish`.
  - `SANDSCAPE_CONFIG_DIR` — directory containing `credentials.json`. Give
    development and production different directories to keep both logins without
    replacing `HOME` for the surrounding coding tool.

## Local clone layout

```
<clone>/
  .sandscape/
    project.json   session_id, base_version, api_url
    design.json    durable, agent-readable game design (read this first)
    manifest.json  { portablePath -> { sha256, version } }  (do not hand-edit)
  CLAUDE.md        generated guide
  AGENTS.md        generated guide (mirrors CLAUDE.md)
  .claude/skills/, .agents/skills/  this skill
  index.html       served entry point (special; keep at the root)
  <anything else>  your game — any structure, mirrored to generated_assets/
```

The clone root mirrors the platform's `generated_assets/` 1:1. Internally each
file is sent with a one-segment `assets/` transport prefix that the server
strips — you never deal with it; just use normal relative paths.

## Commands & flags

### `sandscape pull [dir] [--force] [--json]`
Downloads the changed server files (SHA-256 verified), updates the local manifest
and base_version. Without `--force`, it REJECTS (exit 1, no changes) if the server
advanced AND a locally-edited file would be overwritten — run `--force` to let the
server win on conflicting files. `--force` discards those local edits, so confirm
with the user (or back the files up) before using it.

### `sandscape push [dir] [--json]`
Uploads changed/new files (delta vs the local manifest). Reject-on-divergence: if
your base_version is behind the server, it exits non-zero and tells you to
`pull` first; local state is left unchanged. On success it bumps base_version.
Each file is limited to **50 MB**, and one push is limited to **500 MB / 5,000
files** (exact byte limits: 50 × 1024² per file and 500 × 1024² total). Files
stream in 64 KB chunks; add intentionally local large files to
`.sandscapeignore` rather than trying to bypass the server limit.

On success it also prints a **play link** (`<web>/creating?session=<sid>`) so the
user can try the pushed game; the bare URL lands on the Sandbox preview tab. The
link needs a web origin, resolved the same way as the asset review links:
`--web-url`, else `$SANDSCAPE_WEB_URL`. Without one, `push` prints a hint and the
`--json` `play_url` is `null`.

### `sandscape list [--json]`
Lists the user's projects. `--json` emits the complete project array as one
compact JSON document and never opens the interactive picker.

### `sandscape publish [dir] [--check|--prepare] [metadata] [media] [--web-url <url>] [--json]`
Publishes the game. The server rebuilds and re-validates from its own bundle; the
CLI sends metadata and media. Prints the play URL
(`<web-origin>/play?g=<short_code>`).

Modes:
- `--check` — readiness report only: which fields are set/missing, the allowed
  `--genre` values, and whether the game is already published. Changes nothing.
- `--prepare` — saves the draft, then uploads media and generates cover art from
  it, prints a `review_url`, and stops short of publishing. The user finishes on
  that page.
- neither — publishes directly.

Metadata: `--title <t>`, `--genre <g>` (must be one of the values from
`--check`), `--tagline <t>`, `--short-description <d>`, `--long-description <d>`,
`--tags a,b,c`, `--visibility public|unlisted` (default `public`),
`--platforms desktop|mobile|both` (server default `both`; an unknown value is
exit 2 client-side).

Media:
- `--banner <path>` — png/jpg/webp/gif, ≤10 MB; converted server-side to WebP.
- `--gameplay <path>` — mp4/mov/webm/m4v/avi/mkv, ≤200 MB; converted server-side
  to WebM, trimmed to the **first 20 seconds**, audio dropped. Optional but
  strongly encouraged — footage drives plays. No local encoding tools are
  required, but if you can edit video, pre-cut the best ~20 s as a muted WebM
  and upload that instead of a large raw capture.
- `--generate-banner [direction]` — AI cover art, native 16:9, with the game
  title rendered as key-art lettering. The image is composed from the staged
  draft, your art direction, and stills sampled from the uploaded gameplay
  footage — so stage the draft and upload footage first (a single `--prepare`
  call does this in the right order). Always pass a direction. First **3 per
  project** are free, capped at **6/day per user** server-side, then it costs
  coins; the response includes `free_generations_remaining`. Regenerating with a refined direction is the
  intended way to iterate.

### `sandscape clone <session_id> [dir] [--json]`
Clones a project into `dir` (defaults to the session id). Writes the
`.sandscape/` scaffold, downloads all files, and generates the guides + this
skill in a private sibling staging directory. Every download is SHA-256 verified;
the complete tree is atomically published at the end. `dir` must not already
exist, and a failure leaves no partial clone there.

### `sandscape init <folder> [--name <n>] [--json]`
Imports `folder` as a NEW Sandscape project: creates the project, maps the folder
tree verbatim into the game, uploads it, and auto-registers recognized asset files
(images/3D/audio) for free. Code/config files are kept but not registered as
assets. The import is open to every account — just a login.

`--name` sets the project name; omitted, it falls back to the folder basename
prettified (`train-game` → "Train Game"). Pass the game's real title instead.

**Exclusions.** init (and `push`) skip paths matched by `.gitignore` or
`.sandscapeignore` at the folder root, and ALWAYS skip `node_modules/` and
`.git/`. Supported ignore syntax: comments, blanks, negation (`!`), directory
patterns (`dist/`), root-anchoring (leading `/`), basename matching (no slash →
any depth), and `*`/`**`/`?` globs (root-level ignore files only — nested
`.gitignore` files are not read). Symlinks are never followed. init prints a
one-line summary of what it excluded. This is intentional: a file ignored by
`.gitignore` does not sync. Update `.gitignore` if an ignored reference/game
asset belongs on Sandscape; use `.sandscapeignore` for additional local-only
paths. Create a `.gitignore` before importing if the folder has build output or
dev dependencies.

**Compiled projects.** The CLI does not run a build command. Connect a
browser-ready static folder with `index.html` at its root, not a source tree
that requires Vite, Webpack, TypeScript, JSX, or a server runtime. Build first.
If the build tool clears its output directory, copy the finished build to a
stable staging directory and connect that directory so later builds do not erase
`.sandscape/project.json`. Preserve `.sandscape/` when refreshing the staged
files, then run `sandscape push <staging-directory>`.

## `--json` event shapes

Login (`sandscape login --json`) — a line-delimited event stream for driving an
unattended, backgrounded authorization:
```
{"event":"verification","verification_uri":"https://…/device","user_code":"ABCD-EFGH","verification_uri_complete":"https://…/device?code=ABCD-EFGH","expires_in":900,"interval":5}
{"event":"authorized","scopes":["cli"]}
```
On failure the final line is `{"event":"error","error":"device_flow","message":"…"}`
and the process exits 1. The token itself is never emitted.

Progress (clone/pull/push/init transfers):
```
{"event":"start","total":76,"kind":"download"}
{"event":"progress","done":12,"total":76,"path":"assets/img/hero.png","kind":"download"}
{"event":"done","total":76,"kind":"download"}
```

Push (`sandscape push --json`) ends with a `pushed` event:
```
{"event":"pushed","success":true,"session_id":"…","new_version":42,"play_url":"https://web.example/creating?session=…","files":["assets/index.html"],"assets":[],"rejected_assets":[],"intents_cleared":0,"intents_pending":0}
```
`play_url` is the play link (`<web>/creating?session=<sid>`) when a web origin is
known (`--web-url` or `$SANDSCAPE_WEB_URL`), else `null`.

Every output line in `--json` mode is independently parseable JSON. Warnings use
`event:"warning"`; handled and unexpected errors use `event:"error"`, an
`error` code, a message, and a non-zero exit code.

## Exit codes

- `0` success.
- `1` handled failure (not authorized, divergence/reject, validation, not a clone
  dir, folder not found). The message says what to do (e.g. "run sandscape login",
  "pull first").
- `2` usage error (unknown command/flag).

## Version / divergence model

Each project has a server `current_version`; the clone records the `base_version`
it last synced. `push` is accepted only when `base_version == current_version`
(then it bumps to a new version). A behind `base_version` is rejected (`pull`
first); an ahead one means the clone is stale (re-clone). There is no automatic
merge — divergence is always surfaced for explicit resolution.
