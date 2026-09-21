# Sandscape Assets — reference

Per-kind flags for `sandscape generate`, plus the two flows that need more
structure than a single call. The skill body (SKILL.md) has the workflow and the
budget rules; this file is the detail.

**No prices anywhere in this file.** The CLI resolves live cost per call and
prints it in the `quote` event.

## Shared flags

Every `generate` kind takes:

- `--out <dir>` — where artifacts land. Default
  `.sandscape/generated/<request_id>/`, which is CLI-managed and never pushed.
  Move keepers into the game tree yourself.
- `--name <prefix>` — output filename prefix (and, for `rig`/`animation`, the
  required name of the character or clip). This is a FILE name, not a registry
  asset name.
- `--in <file>` — the input file for kinds that take one. Accepted extensions:
  images `.png .jpg .jpeg .webp` (≤15MB), audio `.mp3 .wav .ogg .flac .m4a
  .aac` (≤50MB), models `.glb .gltf` (≤50MB). A kind that takes no input
  refuses `--in` rather than ignoring it.
- `--asset <name>` [`--field <field>`] — record the intent to register the
  output as that platform asset on the next `push`. Only valid together with an
  `--out` inside the game tree: the default staging dir never pushes, so an
  intent there would be dead. After moving a file, use `sandscape asset tag`
  instead. `--field` needs `--asset`, and must be one of the registry's
  versioned path fields (`concept_art_path`, `model_3d_path`,
  `rigged_model_path`, `tpose_image_path`, `audio_path`, `sfx_path`,
  `collider_mesh_path`, …); otherwise it is derived from the file extension.
  If a call returns several files that could back the asset, the CLI records
  nothing and tells you to tag the one you keep. The push that carries a tag
  answers it: `created`/`updated`/`unchanged` retire it, `rejected` keeps it
  pending with the platform's reason.
- `--json` — line-delimited events (`quote`, `start`, `progress`, `done`,
  `error`).

Kind-specific flags map one-to-one onto the generator's own parameters.
`sandscape --help` is the authority on what this version accepts; the sections
below say what each parameter *means*.

## Image kinds

### `generate image "<prompt>" [--model <m>] [--aspect <r>] [--name <n>]`
Text-to-image. `--model` picks the backend (several, each with its own
character; the default is the fast general-purpose one) and `--aspect` the
aspect ratio, which only some backends honour.

When the framing depends on `4:5`, select Seedream explicitly:
`--model seedream --aspect 4:5`. The default `z_image_turbo` model is fixed
at 1:1 and ignores aspect ratios; do not pass `--aspect` with it.

Write the prompt from the `style_guide`, not from the object alone: subject,
framing, rendering style, palette, lighting, and the intended use (tileable
texture, sprite on transparent background, key art). "crate" gets you a stock
crate; "weathered oak crate, hand-painted diffuse, muted autumn palette, top-down
game view, flat lighting" gets you an asset that fits the game.

### `generate image-fast "<prompt>" [--aspect <r>] [--name <n>]`
The quick draft path — fewer options (prompt, aspect ratio, name) and a faster
turnaround. Use it to explore a direction or fill a placeholder, then run the
direction you chose through `image` when it matters. Compare the two `quote`
events if the difference matters to the budget.

### `generate image-edit "<instruction>" --in <image> [--model <m>] [--name <n>]`
Edits an existing image per the instruction — recolor, remove an element, change
a material, extend a background. The instruction describes the CHANGE, not the
whole picture. Prefer this over a fresh generation when you already have art that
is nearly right: it keeps the visual identity the user approved.

### `generate depth --in <image> [--name <n>]`
Grayscale depth map from an image (parallax layers, displacement, fake 3D).
Its live cost arrives in the `quote` event like every other kind's.

## 3D kinds

### `generate 3d --in <image> [--name <n>]`
Image → textured 3D model. Feeds on a clean, single-subject image on a plain
background — concept art from the registry or a fresh `generate image` works
better than a photo or a busy scene. Takes a name that becomes the output file
prefix. Long-running; expect minutes, watch the progress events.

Check the model before you keep it: load it, look at scale and orientation, and
be ready to re-orient it in your engine code rather than regenerating.

### `generate rig --in <concept image> --name <character>`
Concept art → a T-posed, rigged character GLB (plus the generated T-pose image).
Requires a character name for the outputs. The rigged GLB is the required input
for `generate animation`, so rig once per character and reuse it. Front-facing,
full-body, arms-clear concept art gives the best result; a three-quarter action
pose gives the worst.

### `generate animation "<motion>" --in <rigged .glb> --name <clip>`
Text → an animation clip retargeted onto the rigged character. The prompt
describes the MOTION ("idle breathing, slight weight shift", "walk cycle,
forward, confident"), and the clip takes a name that identifies it in the
animation editor (`knight_idle`, `knight_walk`). One call per clip.

## Audio kinds

### `generate music "<prompt>" [--model <m>] [--duration <s>] [--lyrics <t>] [--name <n>]`
Music from a description. `--model` picks the backend (they differ on vocals vs.
instrumental, orchestral vs. ambient, and on how long a track they will make),
`--duration` asks for seconds where the backend supports it, and `--lyrics`
only means anything on a backend that sings. Describe instrumentation, tempo,
mood, and the moment it plays under ("looping exploration theme, sparse strings
and low piano, unhurried").

### `generate sfx "<prompt>" [--duration <s>] [--prompt-influence <n>] [--name <n>]`
Short game sounds: impacts, UI cues, foley, ambience. `--duration` is seconds
(short, capped — omit it to let the generator choose from the prompt) and
`--prompt-influence` moves between creative (low) and literal (high). Name the
material and the action, not the feeling: "wooden crate splintering on stone,
close mic, dry" beats "destruction sound".

### `generate voices [--search <name>] [--category <category>]`
Lists available voices with their ids and metadata; it never draws on the
budget. Run it before `tts` or `voice-change` and pick deliberately; do
not guess a voice id. With `--json` it emits a single `{"event":"voices", …}`
line — no quote, no artifacts.

### `generate tts "<text>" --voice <name-or-id> [--model <m>] [--name <n>]`
Speaks the text in the chosen voice. One call per line. The text is the line
exactly as it should be heard — you wrote the script, so punctuate it for
delivery (commas for beats, ellipses for hesitation).

### `generate voice-design "<description>" [--preview-text <t>] [--guidance <n>] [--name <n>]`
Designs a custom voice from a natural-language description ("gravelly older
smuggler, dry humour, mid-Atlantic") and returns candidate voice ids plus preview
audio (`--preview-text` sets the line they speak, `--guidance` how closely the
result follows the description). Use it when no listed voice fits the character;
record the returned voice id next to that character in your script file so every
later line reuses it.

### `generate voice-change --in <audio> --voice-id <id> [--remove-noise] [--name <n>]`
Re-performs an existing audio recording in a different voice, keeping timing and
delivery; `--remove-noise` cleans the input first. Useful for turning one
recorded take into several characters.

## Flow: voice-over

Writing the script is writing — that part is yours. The platform casts and
performs it. There is no CLI door that pushes a script into the web voice panel:
keep the script in the repo, push it as a file, and point the user at it.

1. **Write the script locally** as a file the user can read and edit — one entry
   per line with a stable id, the character, and the text:

   ```json
   [
     { "id": "intro_01", "character": "Narrator", "text": "The valley remembers." },
     { "id": "guard_01", "character": "Gate Guard", "text": "Nobody passes at night." }
   ]
   ```

   Keep it in the game tree (e.g. `dialogue/voiceover.json`) so it pushes with
   everything else and the user can see it.
2. **Pick voices** — `generate voices` to browse, or `generate voice-design` for
   a character nothing fits. Record which voice each character got, next to the
   script.
3. **Generate the lines** — one `generate tts` per entry, named after the line id
   so audio and script stay matched.
4. **Place, push, link** — move the audio into the game tree, wire it into the
   game, `sandscape push`, and send the user
   `<web>/creating?session=<sid>&panel=voice-cast` to hear the cast and adjust.
5. **Continue** — when they've made changes there, `sandscape pull` before you
   touch the audio again.

## Flow: character animation

1. **Concept art first** — from the registry, or `generate image` (front-facing,
   full body, plain background, arms away from the torso).
2. **Rig once** — `generate rig`, keep the rigged GLB path; every clip retargets
   onto it.
3. **One clip per call** — `generate animation` per motion (idle, walk, run,
   hit, death). Name clips consistently; the animation editor lists them by name.
4. **Place and wire** — move the clips into the game tree and load them from your
   code.
5. **Push and link** — `sandscape push`, then
   `<web>/creating?session=<sid>&panel=animation-generation` so the user can trim
   loops and tweak playback.
6. **Integrate after their pass** — `sandscape pull`, then adjust the game code to
   the clips as edited. Don't regenerate a clip the user has already tuned.

## Local staging layout

```
<clone>/
  .sandscape/
    project.json          session id + version bookkeeping
    design.json           concept, style guide, design documents, asset registry, plans
    budget.json           { approved, spent } for this task
    pending_assets.json   files tagged for registration on the next push
    generated/<request_id>/
      <artifacts>         raw generation output (staging; never pushed)
      generation.json     the tool's own report (voice ids, durations, …)
      response.json       the paid request's receipt — written BEFORE the call,
                          completed after it; `generate fetch` reads it
  assets/, models/, audio/, …   the game — anything you place here pushes
```

Everything under `.sandscape/` is CLI-managed: it never uploads and never reaches
the served game. A generated file only exists on the platform once you move it
into the game tree and push it.

## Recovering a paid run

Everything around the charge can fail — a broken transfer, a closed terminal, a
crash, a connection that dropped before the answer came back. None of it is a
reason to pay again.

The CLI names the request itself and writes
`.sandscape/generated/<request_id>/response.json` **before** the call leaves the
machine, then completes it with what the run charged and which files the
platform is holding. So the id exists on disk (and in the `start` event) even
for a run whose answer never arrived. Then:

```bash
sandscape generate fetch <request_id> [--out <dir>] --json
```

re-downloads them, free, into the directory the original run was using (or
`--out`). If the local receipt is only the pre-flight stub, fetch asks the
platform what that request delivered and downloads it from there — nothing is
stranded just because the reply was lost. The `request_id` is in the `start`
event, the `done` event, and every `error` event.

The platform keeps the files for a limited time, so fetch first and ask
questions after. `artifacts_expired` means it holds nothing for that id — the
run delivered nothing, or the files were swept — and the only option left is a
new, paid generation. A `download_failed` there is the opposite: a transport
problem, so try again before concluding anything.

## Exit codes

- `0` success.
- `1` handled failure. The message says what to do. Nothing was spent on
  `budget_exhausted`, `insufficient_coins`, `coin_service_unavailable`,
  `price_changed`, `request_id_in_use`, `server_refused`, `unpriced_action`,
  `price_unavailable`, `generate_rejected`, `not_a_clone` or `not_authorized`.
  The charge STANDS on `generate_interrupted`, `download_failed`,
  `artifact_sha_mismatch`, `artifacts_expired` and on `generation_failed` when
  its `charged` is above zero — verify with `sandscape balance` and recover with
  `sandscape generate fetch`, using the `request_id` every one of those events
  carries.
- `2` usage error — unknown kind or flag, a missing required flag, a bad
  `--field`, an `--in` file of the wrong type or size. Nothing was sent.
