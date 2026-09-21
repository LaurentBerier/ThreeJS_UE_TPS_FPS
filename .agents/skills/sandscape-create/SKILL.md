---
name: sandscape-create
description: >-
  Scaffold a browser game for Sandscape and structure it so it actually runs on
  the platform: Three.js-first (Sandscape is a 3D/WebGL platform), the engine
  vendored into `js/lib/three/` as pure ES modules behind a relative import map,
  relative asset URLs, and NO build server or runtime npm/CDN. Load whenever the
  user is about to write the game's FIRST code for Sandscape, INCLUDING a folder
  that already holds `.sandscape/project.json`, design docs and assets but no
  playable `index.html` or entry module yet. Connecting/pushing/publishing is
  sandscape-cli; generating art/audio is sandscape-assets.
allowed-tools: Bash, Write, Edit, Read
---

# Sandscape Create

You are starting a **new browser game** and it is going to live on Sandscape. The
platform serves your game as **static files** behind an injected `<base href>`
that points assets at a CDN — there is **no build server, no Node server, no
bundler, no package manager at play time, and no runtime CDN dependency**. Get
the structure right now and the game runs unchanged the moment it is served;
get it wrong and it works on your machine and 404s in production.

This skill scaffolds the game. The other two take over from there:

- **sandscape-cli** — connect the folder (`init`), sync (`pull`/`push`), publish.
- **sandscape-assets** — generate real art, audio, models, rigs and animations
  (paid) once the game has hooks for them.

Build a **running, self-contained game** with placeholders first; connect and
push it; then replace placeholders with generated assets. Do not design the whole
asset pipeline before there is a cube on screen.

## Concept to code hand-off

If the folder already holds `.sandscape/project.json` with design docs and
assets, the project was started on Sandscape and the game code is what is missing.
The design on the platform IS the brief. Run `sandscape pull` first: it writes
`.sandscape/design.json` (concept, style guide, the design documents, asset
registry, plans) and puts the asset files on disk. Read design.json, then
scaffold the game around it. Do not regenerate assets that already exist: wire
the game to load the files you pulled.

## Default to Three.js (this is a 3D platform)

Sandscape is built around **Three.js / WebGL**. Its entire asset pipeline speaks
3D — image→3D models, rigged characters, retargeted animations, splat worlds,
HDRI/PBR lighting rigs, the scene and material editors. A new game gets the most
out of the platform when it is a **Three.js game**, so that is the default.

- **Default:** a Three.js (WebGL 3D) game, engine vendored as ES modules.
- **2D is the exception, not the tie-breaker.** A genre that is inherently 2D
  (a card game, a word puzzle, a retro tile arcade) can be plain canvas/DOM — but
  treat that as a deliberate choice the user confirmed, not the easy path you
  reach for. When in doubt, or when the idea has any spatial/physical dimension,
  build it in Three.js. Don't quietly ship a 2D canvas game because it was faster
  to stand up.
- Either way the **static-serve rules below are identical** (relative URLs, no
  build step). Only the engine-vendoring section is Three.js-specific.

## The layout to scaffold

This is the exact structure the platform itself provisions — match it so a CLI
game clones and pulls identically to one built on Sandscape:

```
index.html                       # import map + <script type="module"> entry
js/
  main.js                        # your entry module
  <your game modules>.js         # lighting, world, player, … (ES modules)
  lib/three/                     # the VENDORED engine — SHIPS with the game
    build/three.module.min.js    #   primary ES-module build
    build/three.core.min.js      #   three.module.min.js re-exports from this
    examples/jsm/                #   full addons: loaders, controls, postprocessing…
css/style.css
assets/  models/  audio/         # game content (sandscape-assets fills these)
```

Reference **every** file with a **relative** URL — `js/main.js`,
`assets/ship.glb`, `fetch('data/level.json')`. Never a leading slash
(`/js/main.js`): the injected `<base href>` makes leading-slash paths bypass the
CDN and 404 in production while working locally. The full cross-origin contract
(anonymous loads, `img.crossOrigin`, workers via blob URLs) is in the
**sandscape-cli** skill's *Published runtime contract* — read it before you write
code that loads an asset or starts a Worker, and apply it from the first line.

## Vendor Three.js into the game (the node step)

Sandscape will not run npm or a bundler for you. So you use Node **now, at build
time, on your machine** only to FETCH the engine, then you **copy the files into
`js/lib/three/`** where they ship as plain ES modules. Runtime never sees npm.

```bash
npm init -y >/dev/null 2>&1   # only if there is no package.json yet
npm install three@0.185.1
mkdir -p js/lib/three/build js/lib/three/examples
rm -rf js/lib/three/examples/jsm   # a rerun must replace the tree, not nest jsm/jsm
cp node_modules/three/build/three.module.min.js js/lib/three/build/
cp node_modules/three/build/three.core.min.js   js/lib/three/build/
cp -r node_modules/three/examples/jsm js/lib/three/examples/jsm
```

Install the version the platform ships (`THREEJS_VERSION` in the platform's
runtime-versions.env; `0.185.1` today); addons and build must come from the same
version. The rules behind these copy lines (the full dependency closure) and the
two verify checks to run BEFORE you write gameplay code are in
[threejs-vendoring.md](threejs-vendoring.md) in this skill folder. Read it
whenever the game imports three.

### The import map (relative paths ONLY)

Put this in `index.html` — it is what lets `import ... from 'three'` resolve to
the vendored file with no bundler:

```html
<script type="importmap">
{
  "imports": {
    "three": "./js/lib/three/build/three.module.min.js",
    "three/examples/jsm/": "./js/lib/three/examples/jsm/"
  }
}
</script>
<script type="module" src="js/main.js"></script>
```

Then import with **bare specifiers** everywhere:

```javascript
import * as THREE from 'three';
import { GLTFLoader }   from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
```

**Never a CDN `<script>` for three, never a bundler, never an absolute import-map
path.** Absolute paths break the moment the game is served from the CDN origin
under a path prefix. A ready-to-copy `index.html`, `main.js` and `style.css`, plus
the exact vendoring script, are in [reference.md](reference.md).

## The one gotcha that breaks published CLI games: SHIP the engine

`node_modules/` is **build-time only** and the CLI never pushes it (always
ignored) — good, leave it out. But `js/lib/three/` is the game's **actual engine**
and it **must reach the platform**. Two traps:

1. **Do not `.gitignore` `js/lib/`.** Sandscape's own in-app games gitignore it
   *because the server provisions the engine for them*. A CLI game has no such
   server step — it ships its own copy. `sandscape init`/`push` honor
   `.gitignore`, so a line like `js/lib/` (or a broad `lib/`) silently drops the
   engine and the published game dies with bare import-map 404s. Gitignore
   `node_modules/` and any temp build dir; **keep `js/lib/three/`.**
2. **Verify after the first push.** `init`/`push` print how many paths went up and
   how many were excluded — check `js/lib/three/` is in the uploaded set, not the
   excluded one. If a freshly published game shows nothing / a module error, this
   is almost always why.

## Frameworks, bundlers, TypeScript

Prefer **plain ES modules** — it is exactly what the platform serves, with no
build in the way. If the user insists on Vite/React/a bundler, that is the
"needs a build" case: they must produce a **static export**, and the export's
output directory (the one with `index.html` at its root) is what gets connected —
not the source repo. Sandscape runs no build command. The full build-output
handling is in **sandscape-cli**'s *Connecting your own game*.

## When the scaffold runs, hand off

1. **Get it running locally.** Open `index.html` (a plain static server is
   enough) and confirm the scene draws and input works. A game that does not run
   on your machine will not run on the platform.
2. **Connect and push** with **sandscape-cli**. A brand-new folder runs
   `sandscape init . --name "<title>"`; a folder that already held
   `.sandscape/project.json` just runs `sandscape push`. Either way sandscape-cli
   hands the user a play link to try it, and drives publishing only when they
   want it public.
3. **Fill in real assets** with **sandscape-assets**: it reads the design +
   registry, budgets once, generates, and hands back review links. Build the
   loading hooks here; let that skill make the art.

Keep the game browser-runnable at every step. The platform adds hosting, paid
generation and review — it does not add a build step you can lean on.
