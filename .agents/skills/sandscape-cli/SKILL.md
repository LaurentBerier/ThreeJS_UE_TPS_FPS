---
name: sandscape-cli
description: >-
  Put a browser game on Sandscape and keep it there: connect a local game folder
  to the platform, clone or pull an existing project, push local changes back,
  and drive the publish flow through to a review link. Use this whenever the user
  mentions Sandscape, hosting/uploading/importing a game, cloning, pulling,
  pushing or publishing a game project, the `sandscape` command, or when a
  `.sandscape/project.json` exists in the folder — even if they phrase it as
  "put my game online" without naming Sandscape.
allowed-tools: Bash(sandscape *), Bash(npx @sandscape/cli *)
---

# Sandscape CLI

Sandscape hosts and publishes browser games. This skill drives the **Sandscape
CLI**, which does four things: connect a local game folder to the platform,
clone an existing project down, sync files both ways, and publish.

## Scope: this skill moves files, it does not change the game

Nothing here tells you to edit, improve, refactor, or test the game. The tool
you're running inside already edits code when the user asks it to — that is its
job, and the user's request is the only mandate for it.

So after connecting or syncing a project, resist the urge to go find things to
fix. Unsolicited gameplay changes are the most common way this goes wrong: the
user asked to get their game onto Sandscape and got a *different game* back,
with tweaks they never approved. Sync, then return to whatever the user actually
asked for.

The same goes for the very first run: **if the user only asked to install this
skill, installing it IS the task.** Confirm it's installed and stop — don't log
in, probe, sync, or touch any project until they ask for something. The steps
below are for when the user has an actual request (import, pull, push, publish).

Two DIFFERENT skills ship alongside this one; this skill only moves files that
already exist:
- **sandscape-create** — writing the game's code: scaffold it Three.js-first,
  vendor the engine into `js/lib/three/`, structure it so the platform serves it.
  **No game code yet -> read sandscape-create**, whether or not
  `.sandscape/project.json` exists (a platform-started project arrives connected,
  with design docs and assets but no playable `index.html`).
- **sandscape-assets** — making an asset the game does not have yet: the generate
  → place → push → review-link loop (images, 3D, music, sound effects, voices,
  rigs, animations, paid from the user's coin balance). Read it when the user
  needs new art, audio, or animation.

## Step 1 — Detect what you're working with (do this FIRST)

Before anything else, classify the current folder. Run this ONE command. It
reports exactly one of three cases (a connected project with none of the entry
files the platform serves, `index.html`, `game.html` or `src/index.html`, has
no game code yet):

```bash
if [ ! -f .sandscape/project.json ]; then echo "NOT_CLONE";
elif [ -f index.html ] || [ -f game.html ] || [ -f src/index.html ]; then echo "CONNECTED_HAS_CODE";
else echo "CONNECTED_NO_CODE"; fi
```

- **`CONNECTED_HAS_CODE`** → a connected clone with a game already in it. Go to
  **Step 2** (auth), then **Step 3** (pull / push / publish).
- **`CONNECTED_NO_CODE`** → connected to the platform, but there is **no game
  code yet** (no entry file). A project started on Sandscape arrives this
  way: design docs and assets, no playable entry module. **Read sandscape-create
  FIRST** and build the game around the pulled design (see *Concept to code
  hand-off* below), THEN come back here to `push`.
- **`NOT_CLONE`** → this folder is NOT a Sandscape clone. Go to **Step 2**
  (auth), then:
  - If the folder **has game files** (an `index.html`, source code, assets) →
    first check whether a known build or staging folder below it already contains
    `.sandscape/project.json`. If one does, that subfolder is the connected
    project. Use it instead of creating another project. Otherwise this is the
    user's own game, not yet on the platform. After auth, decide which folder is
    actually browser-ready before running `sandscape init` (see *Connecting
    your own game* below). Do NOT try to match it to an existing project from
    `sandscape list`.
  - If the folder is **empty** → either the user wants an existing project
    (after auth, `sandscape clone <session_id> .` to pull one down), or they want
    to START a new game here — that is the **sandscape-create** skill: scaffold it
    first, then come back to `init`. Ask which if it isn't obvious.

Do not skip this step. Do not assume the folder is a clone based on:
- a `CLAUDE.md` or `AGENTS.md` file (generated guides — can be stale/orphaned),
- `.claude/` or `.agents/` directories (created by skill install, not by clone),
- `~/.sandscape/` in your home dir (credentials, created by `login`).

**Only `.sandscape/project.json` in THIS folder proves it is a connected clone.**
If that file is missing, treat it as a new game — do NOT try to pull or clone.

### Concept to code hand-off (`CONNECTED_NO_CODE`)

A project started on Sandscape arrives connected but with no game code. Run
`sandscape pull` first: it writes `.sandscape/design.json` (concept, style
guide, the design documents, asset registry, plans) and puts the asset files on
disk. That IS the brief. Hand off to **sandscape-create** to scaffold the game
around it (it has the layout and vendoring rules), and do not regenerate assets
that already exist. Then come back here to `push`.

## Step 2 — Authorize this machine

This skill is **instructions only** — it does not put a `sandscape` binary on
PATH. Invoke the CLI through npx. Every example below is written as bare
`sandscape …` for brevity; read that as `npx -y @sandscape/cli@latest …` (or a
real `sandscape` if the user installed one globally — they're interchangeable).
So `sandscape pull` means `npx -y @sandscape/cli@latest pull`. Having this skill
loaded means the guidance is present, **not** that anything ran: actually run the
CLI; do not report the setup as "already done" and stop.

**Check whether this machine is already authorized — don't re-login blindly.**
Probe cheaply and only log in if the probe says you're not:

```bash
npx -y @sandscape/cli@latest list --json 2>&1 | head -1
```

- If the output is a JSON array (starts with `[`) → already authorized. Go
  straight to the action you decided in Step 1 (init / clone / sync).
- If the output contains `"not_authorized"` → run the login below.

**Log in (only if the probe said you're not).** Tell the user they'll approve
this machine in their browser, and that if they don't have a Sandscape account
yet they can **create a free one on that same page** — it takes a minute. Any
Sandscape account can clone, connect a game, push, and publish. Login
blocks until they approve, so run it in the **background** and read its events
from a file — never wait on it in the foreground:

```bash
LOG="${TMPDIR:-/tmp}/sandscape-login.jsonl"
npx -y @sandscape/cli@latest login --json > "$LOG" 2>&1 &
LOGIN_PID=$!
```

  a. Poll `$LOG` until its first line appears — a `{"event":"verification", …}`
     object. Show the user `verification_uri_complete` as a clickable link (fall
     back to `verification_uri` + `user_code`) and ask them to open it, sign in
     or sign up, and approve.
  b. Then `wait "$LOGIN_PID"`. Exit **0** → the last line is
     `{"event":"authorized", …}`; you're in. Exit **1** → the last line is
     `{"event":"error", …}`; tell the user, then re-run to retry.

Once authorized the scoped token is stored on the machine (`~/.sandscape/`) and
every other command works with no further prompts.

## Step 3 — Run the one action the user asked for, then hand back

| Situation | Do this |
|---|---|
| Own game, not connected | `sandscape init` — see *Connecting your own game* |
| Empty folder, wants an existing project | `sandscape clone <session_id> .` |
| Already a clone, needs the latest server state | `sandscape pull` |
| Already a clone, has local changes to upload | `sandscape push` |
| Wants to see / try the game | `sandscape push`, then hand over the play link (see *Try the game*) |
| Ready to go public | *Publishing* — drive it to the `review_url` |

When that finishes, stop and look at what the user actually wanted:

- They had another request in flight ("connect this and then fix the jump") →
  go do that request now, with your normal tools. The CLI part is done.
- Publishing was the goal (or they said "put my game on Sandscape", which
  usually means they want it playable by others) → continue to *Publishing* and
  see it through.
- Nothing else was asked → report what happened (project name, what synced) and
  ask what they'd like next. Don't fill the silence with edits.

## How this folder maps to the platform

This directory **is** the game's served root (`generated_assets/` on the
platform). Files can live anywhere under it — there is no required structure. The
only special file is **`index.html` at the root** (the served entry point).
Everything except the CLI-managed metadata below round-trips to the platform
verbatim.

For a project that uses Vite, Webpack, TypeScript, JSX, or another build step,
"this directory" means the stable folder that holds the finished browser build.
It does not mean the source repository. Sandscape serves static files; it does
not run a package manager, build command, development server, or Node server.

CLI-managed — never the game's content, don't push or treat as game files:

- `.sandscape/` — session id, versions, file manifest, and the durable design.
- `CLAUDE.md` / `AGENTS.md` — generated guides.
- `.claude/`, `.agents/` — this skill (and other tool config).

The durable, agent-readable game design (concept, style guide, design documents,
assets, plan) lives in
**`.sandscape/design.json`**. Read it when you need to describe the project —
publish metadata, for instance, or answering the user's questions about it.

## Published runtime contract (when editing or testing a game)

Sandscape serves each HTML document through its authenticated/play-gated API
origin, then injects a `<base href>` pointing at the public game-asset CDN.
Consequently, relative assets are intentionally **cross-origin in production**
even though they are same-origin on a typical local server. The asset CDN is
public and read-only; player cookies and the HTML play token do not gate assets.

When the user's task includes creating, changing, or testing game code, enforce
these rules before pushing or publishing:

- Reference every bundled file with a relative URL such as `js/main.js`,
  `assets/ship.glb`, or `fetch('data/level.json')`. Never use a leading slash
  such as `/assets/ship.glb`; it bypasses the injected CDN base.
- Load CDN assets anonymously. Plain `fetch(relativeUrl)` is fine; explicit
  requests should use `credentials: 'omit'`. For Three.js loaders use
  `setCrossOrigin('anonymous')` where the loader exposes it. Do not add
  credentialed/`use-credentials` fallbacks: the public asset host does not use
  login cookies and wildcard CORS is incompatible with credentialed requests.
- Before assigning `img.src`, set `img.crossOrigin = 'anonymous'` whenever
  that image will be read through `getImageData()`/`toDataURL()`, uploaded to
  WebGL, or otherwise needs an origin-clean canvas.
- Do not pass a relative CDN URL directly to a classic `Worker`: classic worker
  scripts must be same-origin. Fetch the worker source anonymously, construct a
  `Blob`, start the Worker from `URL.createObjectURL(blob)`, and revoke that
  object URL after startup; or bundle the worker into same-document code.
- Exercise these paths with the document and assets on two different local
  origins when practical. A same-origin local smoke test cannot detect canvas
  taint, worker-origin failures, or missing CORS headers.

The CLI uploads files verbatim and cannot repair these browser semantics. A
normal game does not need a cache-busting/credential ladder. Public assets are
delivered anonymously, and loaders should fail clearly with intentional gameplay
fallbacks.

### Vendoring Three.js

When the game imports `three` (a new project, or an edit to one that already
does), vendor the engine as a full dependency closure pinned to the platform
version, and verify it before writing gameplay code. The rules and the two checks
are in [threejs-vendoring.md](threejs-vendoring.md) in this skill folder.

## Syncing the folder with the platform

Two commands move files; neither one implies anything about changing them.

**`sandscape pull`** — brings the folder up to date with the platform (someone
may have worked on the game there). Reject-on-divergence: if it refuses because
the server advanced over a locally edited file, don't force blindly. `--force`
**discards the user's local edits** to the conflicting files, so first tell the
user exactly which files would be lost and get their OK (or copy those files
aside as a backup). Only then run `sandscape pull --force`.

**`sandscape push`** — uploads changed and new files so the platform copy
matches the folder. Reject-on-divergence: if the server moved past your
base_version, `sandscape pull` first, then push again. Pushing never merges —
it rejects so a human resolves the conflict explicitly.

Push after the user's own changes are done, so their work is safe on the
platform. That's the reason to push — not a reason to make changes.

## Try the game (the play link)

After ANY push during development, hand the user the PLAY LINK so they can try
what they just pushed. `sandscape push` prints it as a `play:` line
(`<web>/creating?session=<sid>`); in `--json` it is `play_url` on the `pushed`
event. That page opens on the always-available Sandbox preview, so it is where a
dev iteration is confirmed. The link needs a web origin: pass `--web-url` or set
`$SANDSCAPE_WEB_URL`. Without one, `push` says so; supply it and re-run.

Publishing is NOT how you test. It is the last step for going public, and driving
the publish flow just to see the game wastes the user's time and stages a draft
nobody asked for. Push, share the play link, iterate; publish only when the user
wants the game public.

## Connecting your own game (init)

`sandscape init <folder>` maps the folder tree **verbatim** into a new project,
so choose the served root before you run it. The selected folder must contain a
browser-ready `index.html` at its root.

### Raw or already-static projects

Use the project folder itself when its root `index.html` can run directly from
static hosting and all of its JavaScript and assets are already browser-ready.
A plain HTML, CSS, JavaScript, or Three.js game usually fits this case:

`sandscape init . --name "<the game's real title>"`

Do not assume a root `index.html` proves the folder is ready. In Vite and similar
projects, that file can be a development entry that still imports TypeScript,
JSX, or source modules that only the bundler understands.

### Projects that need a build

If the project has a build script, bundler configuration, TypeScript or JSX
entry points, or a framework runtime, inspect `package.json` and the build
configuration before using the CLI.

1. Run the project's existing production build with its existing package manager.
   Do not invent a new build command when the repository already defines one.
2. Find the configured output directory. Common names are `dist/`, `build/`,
   and `out/`, but the configuration is the source of truth.
3. Confirm that the output has `index.html` at its root and contains the files
   needed to run as a static site. If it still needs a Node server or server-side
   rendering, it is not uploadable as-is. Explain that it needs a static export.
   Ask before changing the project's build configuration.
4. Build **before** `sandscape init`. Build tools often clear their output
   directory, while `init` writes `.sandscape/project.json` inside the folder
   it connects. A later clean build could erase the connection.
5. When the normal output directory is cleared on each build, copy the completed
   build into a stable staging directory and connect that directory instead. Keep
   its `.sandscape/` folder intact. On later updates, rebuild normally, copy the
   new browser files into the connected staging directory, then run
   `sandscape push <staging-directory>`.

Do not connect the source directory just because it contains the game code. If
the browser needs the compiled output, the compiled output is what Sandscape
must receive.

### Ignore rules

`init` and `push` honor `.gitignore` and `.sandscapeignore` at the folder
they connect, and always skip `node_modules/` and `.git/`.

1. For a raw/static project, create a `.gitignore` if none exists. Exclude
   dependencies, caches, coverage, logs, and scratch files. Exclude `dist/`,
   `build/`, or `out/` only when that directory is not the served root you
   selected.
2. In a raw/static project, keep source material that belongs with the game,
   such as concept art, references, raw models, audio, and design documents.
   If one of these is gitignored, update or negate that rule before init or push.
3. A compiled staging directory should contain the browser build, not
   `node_modules/`, credentials, or an extra copy of the source repository.
4. Want git to keep a file but Sandscape to skip it? Put it in
   `.sandscapeignore` (same syntax) instead of `.gitignore`.

init prints how many paths it excluded — check that summary before continuing so
you know the cut was right (e.g. `node_modules/` gone, `assets/` and `reference/`
kept).

**Always pass `--name "<the game's real title>"`** — whatever the user calls the
game; ask them if nothing in the folder makes it obvious. Never leave it to the
default folder name.

After a successful init the game is on Sandscape and the folder is a clone. Tell
the user the project is connected, then go back to Step 3's hand-back: continue
their pending request, move on to *Publishing* if that's the goal, or ask. The
game itself needs nothing from you here — it arrived exactly as they wrote it,
which is the point.

## Publishing a game

Publishing is what most people came for, and it's the step most likely to be
left half-done. Drafting nice metadata is not the finish line. **The finish line
is the user holding a `review_url`** — the page where they press Publish
themselves — or explicitly telling you they don't want to publish yet. A draft
that was never staged and a banner that was never made are the two ways this
stalls out, so carry it all the way through in one pass.

The game goes on Sandscape's **public** site under the user's name, so run it as
a collaboration: you draft, they approve, they press the button. Every step
takes `--json`. Work them in order.

**1. Ask what's missing.**

```bash
sandscape publish --check --json
```

The readiness report says what's already set, what's still missing, whether the
game is **already published**, and the exact list of **genre options**. Always
start here, and never invent a genre — pick one of those options.

**2. Draft the metadata and ask about media in the SAME message.** Getting the
copy approved and then remembering the banner afterwards costs the user an extra
round-trip and is how footage ends up missing. One exchange:

- The draft copy — `--title`, `--genre` (one of the options from `--check`),
  `--tagline`, `--short-description`, `--long-description`, `--tags a,b,c`.
  Write it yourself from the game's code, `.sandscape/design.json`, and any
  design docs; don't interrogate the user for text you can infer.
- **A banner image** — `--banner <path>`: png/jpg/webp/gif, ≤10 MB. Ask if they
  have one, and say you can generate one if not (step 3).
- **A gameplay video** — `--gameplay <path>`: mp4/mov/webm/m4v/avi/mkv, ≤200 MB.
  Optional, and worth saying plainly: **games with gameplay footage are more
  likely to be played.** The server keeps only the **first 20 seconds** and drops
  audio, so if you have the ability to edit video, cut the best ~20-second
  segment to a muted WebM yourself before uploading — you choose the highlight
  instead of whatever the file opens on, and you don't ship a large raw capture
  for 20 usable seconds. If you can't edit video, upload the raw file as-is;
  the server handles it.
- **Which platforms it plays on** — `--platforms desktop|mobile|both`: ask the
  user; only they know whether the controls work on a touchscreen. Then always
  pass the flag with their answer — never omit it and let the server guess.

The server does all the conversion (banner → WebP, video → WebM) and keeps only
the **first 20 seconds** of the video, **audio dropped**. A raw phone clip or
screen recording is fine and **no local tooling is required** — never make the
user install anything. If `ffmpeg` happens to already be on this machine
(`ffmpeg -version` exits 0) you may offer to cut a specific 20-second segment
when the best action isn't at the start — a nicety, never a requirement.

**3. No banner? Generate one — with a direction you wrote.** Don't let a missing
image be the thing that stops the publish.

```bash
--generate-banner "cozy narrow-gauge train crossing an autumn valley viaduct at
dusk, warm amber lanterns against blue-grey mist, painterly storybook rendering"
```

**Always pass a direction.** A bare `--generate-banner` makes the generator work
from metadata alone; you know more than that. Distil what you've seen in the
code and assets into one dense sentence: **subject, genre, setting, mood,
palette, key visual elements**. Never a restatement of the title, and never
skip the direction unless the user insists.

The server does the rest: the banner is generated **natively 16:9** and includes
the **game title** as key-art lettering, composed from the direction plus the
draft you staged (title, tagline, genre, descriptions, tags) — which is why the
draft goes up in the same `--prepare` call, or before it.

**Upload the gameplay footage before (or with) the generation.** When footage is
present the server samples stills from it and feeds them to the generator as
visual reference, so the banner shows *this* game instead of a stock scene. Say
so in the direction too ("elevate the attached gameplay frames, same world and
palette"). Generating first and uploading footage after throws that away.

The first **3 generations per project are free**, up to a **per-user daily cap
(6/day)** enforced server-side — so on your 4th+ project in a day the free
allowance may already be spent even though this project shows some left. Either
way the response carries `free_generations_remaining`, so quote that number. Show
the result, and offer a regenerate with an adjusted direction — name what you'd
change ("push the palette colder, put the locomotive centre-frame") rather than
asking the user to write art direction from scratch.

**4. Stage everything, then hand over the link.**

```bash
sandscape publish --prepare --json \
  --title "Neon Drift" \
  --tagline "Outrun the grid" \
  --genre Racing \
  --short-description "A synthwave time-trial racer built for one perfect lap." \
  --tags racing,synthwave \
  --platforms both \
  --gameplay ./clip.mp4 \
  --generate-banner "lone chrome hovercar carving a neon canyon at night, magenta
and cyan light trails, rain-slick reflections, cinematic synthwave key art"
```

`--title` is required — `--prepare` without it exits 2.

`--prepare` saves the draft first, then uploads the media and generates the
banner from that staged draft, and returns a `review_url` — it does **not**
publish. Give the user that URL as a clickable link and say what's waiting
there: everything is staged, they review it and press Publish. Don't publish on
their behalf; that last click is theirs.

Only if they explicitly ask for an all-CLI publish, run plain `sandscape publish`
with the same metadata flags — the server rebuilds and re-validates from its own
bundle and prints the play URL.

Before you consider the request done, check the right finish line for what was
asked. A development iteration (a push to try changes) finishes when the user has
the **play link** (`<web>/creating?session=<sid>`). Publishing finishes when the
user holds the **`review_url`** (the page where they press Publish) or has told
you to hold off. If the relevant one is still missing, the request is unfinished:
go back and finish it rather than reporting success.

## Commands

Add `--json` to any command for machine-readable, line-delimited output you can
parse (including progress events) instead of human text.

- `sandscape login` — authorize this machine once (device-code flow). Required
  before anything else. With `--json` it emits `verification` then `authorized`/
  `error` events — see **Step 2** above for the hands-off background flow.
- `sandscape logout` — forget the stored credentials on this machine (revoke the
  token server-side from the Sandscape account UI).
- `sandscape pull [--force]` — download the latest version. `--force` overwrites
  local edits on conflicting files — confirm with the user first (see *Syncing*).
- `sandscape push` — upload the folder's changes to the platform; on success it
  prints the play link to try them (needs a web origin; see *Try the game*).
- `sandscape list` — list the user's projects (id, name, status). Also the
  cheap auth probe: exit 0 = authorized, exit 1 = needs `login`.
- `sandscape publish` — publish the game (**public-facing** — confirm with the
  user before running it bare). `--check` prints the readiness report (missing
  fields, genre options, already-published state); `--prepare` uploads media,
  saves the draft, and returns a `review_url` for the user to press Publish on.
  Metadata: `--title`, `--genre`, `--tagline`, `--short-description`,
  `--long-description`, `--tags a,b,c`, `--visibility public|unlisted`,
  `--platforms desktop|mobile|both`. Media:
  `--banner <path>`, `--gameplay <path>`, `--generate-banner [prompt]`. See
  *Publishing a game*.
- `sandscape clone <session_id> [dir]` — clone another of the user's projects
  into a new folder.
- `sandscape init <folder> [--name <n>]` — connect the user's OWN game folder as
  a new Sandscape project. Maps the folder tree verbatim (honoring
  `.gitignore`/`.sandscapeignore`, always skipping `node_modules/` + `.git/` — see
  *Connecting your own game*) and auto-registers recognized asset files for FREE.

## Liveness

Long operations (clone/pull/push) emit per-file progress, and with `--json` emit
`{"event":"progress","done":N,"total":M,"path":"..."}` lines, so you can tell
"working" from "stalled" during big transfers.

For full flags, exit codes, the version/divergence model, and `--json` event
shapes, see [reference.md](reference.md).
