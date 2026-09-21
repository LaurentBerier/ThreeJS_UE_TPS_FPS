---
name: sandscape-assets
description: >-
  Create game assets through Sandscape from your own coding session — images,
  3D models, music, sound effects, voice lines, rigged characters, animations —
  paid from the user's Sandscape coin balance, placed in the local game folder,
  pushed back, and handed to the user as a review link. Use whenever a game in a
  Sandscape clone needs art, audio, or animation it does not have yet, or when
  the user mentions `sandscape generate`, an asset budget, or their coin balance.
allowed-tools: Bash(sandscape *), Bash(npx @sandscape/cli *)
---

# Sandscape Assets

You are the one building this game. Sandscape is where the **paid generation**
happens and where the **user reviews** what came out. Every other decision — what
to make, whether it's good, where it goes — stays here with you.

Every command below is written as bare `sandscape …`; read that as
`npx -y @sandscape/cli@latest …` unless a real `sandscape` is on PATH (they're
interchangeable). Auth, cloning, pull/push mechanics and publishing belong to the
**sandscape-cli** skill — this one assumes you already have a clone and a login.

## What goes to the platform, and what stays with you

| Stays here (your job) | Goes to Sandscape |
|---|---|
| Code, level data, config, shaders, build steps | Image generation (textures, sprites, key art, concept art) |
| Dialogue text, item names, copy, tuning numbers | 3D generation (props, characters, rigs) |
| Deciding **what** to make and **whether it's good** | Audio generation (music, sound effects, speech, designed voices) |
| Deciding **where a file lives** and how it loads | Animation generation for a rigged character |
| Judging your own work before the user sees it | The user's review of what you made, in the web editors |

Write the text yourself. Write the scripts yourself. Do not ask the platform to
design a level, plan a feature, or make a judgment call — that is the work the
user asked *you* to do, and there is no CLI door for it on purpose. Generation is
a tool call, not a hand-off.

## Step 0 — Confirm this is a clone

```bash
test -f .sandscape/project.json && echo "CLONE" || echo "NOT_CLONE"
```

`NOT_CLONE` → stop and use the **sandscape-cli** skill first (`login`, then
`clone <session_id> .` or `init .`). Generation is session-scoped; without a
connected project every command fails with `not_a_clone`.

## Step 1 — Read the design and the registry BEFORE generating

`.sandscape/design.json` is the durable, agent-readable design of this game.
Read it first, every time:

- `game_design_concept` — what the game is.
- `style_guide` — the visual/audio direction. Your prompts must speak its
  language (palette, rendering style, era, mood, camera). An asset that ignores
  the style guide gets thrown away, and the user still paid for it.
- `assets` — **the asset registry**: named entries with descriptions and path
  fields (`concept_art_path`, `model_3d_path`, `rigged_model_path`,
  `audio_path`, `sfx_path`, …) pointing at files in this folder.
- `development_plan`, `animation_plan`, `voice_cast`, `voiceover_script` —
  read when the task touches them.

Then, in this order:

1. **Does it already exist?** Search the registry by name and description, and
   the folder for the file. If it exists, use it.
2. **Does it exist on the platform but not here?** A registry path with no local
   file means the clone is behind — `sandscape pull`, don't regenerate.
3. **Can an existing asset be adapted?** `generate image-edit` on art you
   already have, or `generate 3d` from concept art already in the registry, beats
   starting over — and keeps the game visually coherent.
4. Only then generate something new.

Regenerating what the user already bought is the most expensive mistake
available here, and it is invisible to them until the bill.

## Step 2 — Budget once, up front

Paid calls never prompt. That only works if the user approved a number first.

1. **Estimate the whole task's coin need** before starting — how many images,
   models, sound effects, and how many of those are likely to need a second
   attempt.
2. **Ask the user once, in conversation:** "this needs about N coins — approve?"
   Show them `sandscape balance` if they need the context.
3. **Record the approved amount:** `sandscape budget set N`.
4. **Then work without asking again.** Each priced call checks the remaining
   budget, emits a `quote` event with its live cost, runs, and subtracts what
   the server actually charged. The quote is also a **ceiling**: the CLI sends it
   with the call, so a kind repriced mid-task refuses (`price_changed`) instead
   of spending more than the number you showed the user.
5. **On `budget_exhausted`: stop and ask for a top-up.** That error means the
   call did NOT run and nothing was spent. Report what you finished, what's left,
   and let the user decide.
6. **Never loop retries into the budget.** A result you dislike was still
   charged, and every re-roll charges again. Read what came back, change the
   prompt or the input deliberately, and re-run at most once before you ask.
   (A generation the server reports as FAILED is refunded, and its `charged`
   field says how much actually came back — but an automated retry-until-success
   loop is still the fastest way to burn a balance.)
7. **Never state a price from memory, from a doc, or from this file.** The CLI
   resolves live cost per call; `sandscape balance` and the `quote` event are the
   only truthful sources. Quote those numbers, nothing else.

`voices` never draws on the budget. Any other
kind whose live price resolves to zero skips the gate too — the `quote` event is
what tells you that, per call. Never assume a kind is free because a document
said so; an operator can reprice any of them.

The budget lives in `.sandscape/budget.json` per clone and is a **cooperative
guard against your own runaway loops**, not a security boundary. Treat it as the
user's spoken permission written down.

## Step 3 — Generate, then place the file yourself

```bash
sandscape generate image "weathered oak crate, hand-painted diffuse texture, \
  muted autumn palette, top-down game view" --json
```

- Output lands in `--out` (default `.sandscape/generated/<request_id>/`).
  That directory is CLI-managed and **never pushed** — it's a staging area.
- **Look at what came back** before doing anything else. Wrong subject, wrong
  palette, wrong silhouette → decide: fix it locally (you have image tools and
  code), regenerate with a sharper prompt (costs again), or drop it.
- **Move the keepers into the game tree** yourself, at the path the game actually
  loads them from (`assets/textures/crate.png`, `models/crate.glb`, …). The clone
  root IS the served root; relative paths in your code are what ship.
- **Tag what should become a platform asset** so the user can review and edit it:
  `sandscape asset tag <path> --asset <name> [--field <field>]` once the file
  sits in the game tree. (`--asset` on `generate` does the same thing, but only
  together with an `--out` inside the game tree — an intent on the default
  staging dir would name a file that never pushes, so the CLI refuses it.)
  Tagging is what turns a pushed file into a registry entry with version
  history. Untagged files still push — they're just plain game files, not
  reviewable assets.
- **Tag whenever you decide** — before or after the push that carries the file.
  A tag on a file that is already synced and unchanged still registers it: the
  declaration rides on the file's manifest entry and the platform applies it to
  the copy it already holds. Two tags register nothing: one naming a file the
  project does not have (deleted, renamed, ignored), and one the platform
  REFUSES (ambiguous name, stale view — see Step 4). `push` says so in both
  cases and leaves the tag pending.

Iterate locally as much as you like: editing, moving, and pushing files cost
nothing. Only generation spends coins.

## Step 4 — Push, then hand over a review link

`sandscape push` is the ONLY writer to the platform copy of the game —
generation never touches it, so pushing after a batch of generation is always
safe and never conflicts on its own.

```bash
sandscape push --json --web-url https://sandscape.app
```

The push result reports each registered asset (`asset_id`, name, field, action)
plus a `link` per asset. **Give the user those links.** A generation the user
cannot see is not finished work.

Three actions mean the platform accepted the tag and the intent is retired:
`created` (new registry entry), `updated` (a new version of an existing field)
and `unchanged` (the asset already carries that exact file on that field —
nothing to do, and nothing left to re-send).

A fourth, `rejected`, means it registered NOTHING. The row names the asset and
the server's own `reason`, the tag stays pending, and re-pushing changes nothing
until you fix the cause. The two reasons that exist:

- **ambiguous asset name** — more than one asset answers to that name, so "the
  asset called X" is meaningless. Re-tag with a name that is unique, or ask the
  user which asset they meant.
- **stale view** — the platform's copy of that path is not the file you tagged.
  `sandscape pull` first, look at what came down, then tag again.

Report a rejection to the user in the same breath as the successes. A tag that
silently never registered is a review link that never appears.

`/creating` is a website route, not an API route, so the CLI can only build the
link once it knows the web origin: pass `--web-url <origin>` or set
`SANDSCAPE_WEB_URL`. Without it the assets still register and `link` is
`null` — then say which assets landed and build the URL from the origin the
user browses Sandscape on.

| What you made | Where the user reviews it |
|---|---|
| Images, models, audio tagged as assets | `<web>/creating?session=<sid>&editor=assets&asset=<asset_id>` |
| Voice casting / voice-over lines | `<web>/creating?session=<sid>&panel=voice-cast` |
| Character animation clips | `<web>/creating?session=<sid>&panel=animation-generation` |

Prefer the link the CLI printed for an asset over one you assembled yourself —
it carries the id the server actually registered.

Then say what you made, in one message: how many of what, what you kept and what
you dropped, what it cost against the budget, and the link(s). Ask whether they
want changes on the platform or want you to keep building. If they edit an asset
on the website, `sandscape pull` brings it back down before you continue.

## Generation kinds

`sandscape generate <kind> [prompt] [flags]`:

| Kind | Makes | Needs |
|---|---|---|
| `image` | images from a prompt | prompt |
| `image-fast` | a quick draft image | prompt |
| `image-edit` | an edited version of an image | prompt + `--in <image>` |
| `3d` | a 3D model from an image | `--in <image>` |
| `music` | a music track | prompt |
| `sfx` | a short sound effect | prompt |
| `tts` | a spoken line in a chosen voice | text + `--voice <name-or-id>` |
| `voice-design` | a custom voice from a description | description |
| `voice-change` | one performance re-voiced | `--in <audio>` + `--voice-id <id>` |
| `rig` | a rigged, T-posed character from concept art | `--in <image>` + `--name` |
| `animation` | an animation clip for a rigged character | prompt + `--in <glb>` + `--name` |
| `depth` | a depth map from an image | `--in <image>` |
| `voices` | lists the available voices | — |

Not available from the CLI: splat worlds and video. Per-kind flags, inputs, and
the structured voice/animation flows are in [reference.md](reference.md).

## Commands

Add `--json` to anything for line-delimited machine-readable output.

- `sandscape balance` — the user's live coin balance.
- `sandscape budget` — approved budget, spent, remaining, plus the live balance.
- `sandscape budget set <coins>` — record what the user approved. This RESETS
  the spent counter, so it starts a task rather than topping one up mid-flight;
  set it to what the user approved in total.
- `sandscape generate <kind> [prompt] [--in <file>] [--out <dir>] [--name <n>]
  [--asset <name> [--field <field>]] [kind flags]` — one paid generation (see
  reference.md).
- `sandscape generate fetch <request_id> [--out <dir>]` — download again what a
  paid run already produced. Free, and the answer to any failure AFTER the
  charge (a broken download, a lost terminal, a connection that dropped before
  the answer arrived): the platform keeps the files for a while, and the
  `request_id` from the `start`, `done` or `error` event is all it needs.
  Generating again would pay a second time for the same file.
- `sandscape asset tag <path> --asset <name> [--field <field>]` — mark an
  already-placed file as an asset to register on the next push.
- `sandscape push [--web-url <origin>]` — upload the folder, register/version
  tagged assets, print review links.
- `sandscape pull` — bring platform-side edits back down.

`sandscape --help` prints the flags this CLI version actually accepts — trust it
over any document, including this one.

## `--json` events and errors

A priced generate emits, in order:

```
{"event":"quote","kind":"image","cost":…,"budget_remaining":…,"balance":…}
{"event":"start","kind":"image","tool":"generate_images_from_text","request_id":"…"}
{"event":"progress","kind":"download","done":1,"total":2,"path":"…","size":…}
{"event":"done","kind":"image","request_id":"…","charged":…,
 "budget_remaining":…,"out_dir":"…","files":["…"],"asset_intents":[…],"meta":{…}}
```

The CLI names the request itself, before the call leaves the machine, so
`request_id` is in the `start` event and in **every** error event — including a
timeout or a dropped connection. That id is the handle on anything the run
produced: nothing paid for is ever unreachable because the answer got lost.

`push` ends with `{"event":"pushed", …, "assets":[{"asset_id":"…","asset_name":
"…","path_field":"…","action":"…","version":…,"link":"…"}],
"rejected_assets":[{"asset_name":"…","path_field":"…","reason":"…"}]}` — the
review links, and any tag the platform refused with the reason it gave.

`generate fetch` emits `start` / `progress` / `done` with `"kind":"fetch"` and
no `quote`: there is nothing to charge.

Failures are a final `{"event":"error","error":"<code>","message":"…"}` line with
a non-zero exit:

**Nothing was spent** — say so, then decide:

- `budget_exhausted` — no budget, or less remaining than this call costs. The
  call never left the machine. Ask the user for a top-up.
- `insufficient_coins` — the account balance is too low; the event carries the
  server's balance numbers. Quote those to the user.
- `price_changed` — the platform repriced this kind between the quote and the
  charge, so it refused rather than spend more than the CLI quoted. Nothing ran
  and nothing was drawn down. The event carries `quoted_price` and
  `resolved_price`. **Do not retry at the new price on your own**: the user
  approved a number, not an open tab. Re-run the command to see the fresh quote,
  and if the task no longer fits the approved budget, say so and ask for a
  top-up before spending.
- `request_id_in_use` — the name this run chose already belongs to another
  request in the session. Nothing ran; re-run and a fresh name is chosen.
- `coin_service_unavailable` — the platform could not reach its own coin
  service. An outage, NOT an empty wallet: nothing was charged and a later
  attempt may simply work. Do not send the user to buy coins.
- `server_refused` — the platform declined the call for a reason a purchase
  cannot fix (no active price for that kind, a server-side cap). The event
  carries the server's own `error_code`; report it and stop.
- `unpriced_action` / `price_unavailable` — the CLI could not resolve a live
  price, so it refused to run work it cannot quote.
- `not_a_clone`, `not_authorized`, `generate_rejected` (the server rejected the
  request itself), `voices_failed` (the free listing did not come back) — fix
  the cause and re-run.

**The coins are gone** — the event carries `charged`, and the budget is drawn
down to match:

- `generation_failed` — the generator ran and reported failure; the message
  carries its own text. Read it: it usually says what the input or prompt did
  wrong. The event's `charged` field is what the wallet is actually out by after
  the refund attempt — `0` when the refund landed (budget released), more than
  zero when it did not (the charge stands; check `sandscape balance` and tell
  the user before generating again). Never report success either way.
- `generate_interrupted` — the connection dropped or timed out around a call
  that had already started. The server settles whether or not the CLI is
  listening, so assume it charged. Do NOT re-run: check `sandscape balance`, and
  if the run finished, `sandscape generate fetch <request_id>` gets the files —
  the id is in this event, because the CLI named the request before making it.
- `download_failed` / `artifact_sha_mismatch` — the generation succeeded and was
  charged; only the transfer failed (each file is already retried a few times).
  The event carries `request_id`, `charged`, the artifact list and a `recover`
  command. Run `sandscape generate fetch <request_id>` — never re-generate.
- `artifacts_expired` — the platform holds nothing for that request: either the
  run never delivered anything (it failed or was refused, and a refused run
  charges nothing), or the files have been swept. Either way they cannot be
  recovered; check the balance and say so before spending again.
- `unknown_request` — no saved report for that id in this clone, so there is
  nothing to fetch. Only a request this clone made can be fetched.
- `invalid_response` — the server answered with something the CLI will not build
  a local path from. Do not retry; report it.
- `usage`, `unknown_kind`, `invalid_arguments`, `invalid_field` — exit 2, no
  network call, no charge. Fix the command line.

Never invent a success from a failed call, and never re-run a failed PAID call
blindly: read the code, check the balance, then decide.

## Liveness

Model calls take real time — a 3D model, a rig, or an animation can run for
minutes. The commands emit progress events, so you can tell "working" from
"stalled" instead of assuming a hang and re-running (which would spend again).
