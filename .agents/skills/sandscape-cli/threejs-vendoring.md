# Vendoring Three.js for Sandscape

Read this whenever the game imports `three`: a new project, or an edit to one
that already does. Sandscape serves static files with no bundler and no runtime
npm or CDN, so the engine must ship as a complete set of ES modules the browser
loads directly.

## The rule: vendor the whole dependency closure

Never copy individual Three.js files ad hoc. Copy the COMPLETE closure:

- **Both build files.** Since r159 the build is split: `three.module.min.js` is a
  thin wrapper that re-exports from `three.core.min.js`. Ship one without the
  other and every `import ... from 'three'` breaks.
- **The whole `examples/jsm/` tree.** Addons import each other: `GLTFLoader` pulls
  in `BufferGeometryUtils`, controls and post-processing pull in shared math and
  the `libs/` wasm (draco/basis/ammo). A partial copy fails only when a player
  reaches the missing file, and a rejected ES-module graph is SILENT in the
  console.
- **Same version for build and addons.** A mismatched addon and core is its own
  silent break.

## The pin: match the platform

```bash
npm install three@0.185.1
```

`0.185.1` is the platform's `THREEJS_VERSION` (its runtime-versions.env). A
locally built game must match what the platform's own build agent gets, so pin
this exact version. Do not take whatever a bare `npm install three` resolves to.

## Vendor it in (build-time Node; runtime never sees npm)

```bash
npm init -y >/dev/null 2>&1   # only if there is no package.json yet
npm install three@0.185.1
mkdir -p js/lib/three/build js/lib/three/examples
rm -rf js/lib/three/examples/jsm   # a rerun must replace the tree, not nest jsm/jsm
cp node_modules/three/build/three.module.min.js js/lib/three/build/
cp node_modules/three/build/three.core.min.js   js/lib/three/build/
cp -r node_modules/three/examples/jsm js/lib/three/examples/jsm
```

Import through a RELATIVE import map in `index.html` (an absolute path breaks once
the platform serves the game from the CDN under a path prefix):

```html
<script type="importmap">
{
  "imports": {
    "three": "./js/lib/three/build/three.module.min.js",
    "three/examples/jsm/": "./js/lib/three/examples/jsm/"
  }
}
</script>
```

## Verify BEFORE writing gameplay code

Two checks. Run both before you build anything on top of the engine.

**(a) Static closure.** Every relative import reachable from the import-map entry
points under `js/lib/three/` must resolve to a file that exists. This
dependency-free script walks from the build entry plus every addon the game
imports and prints what is missing, exiting non-zero if anything is:

```js
// check-three.mjs: node check-three.mjs   (exit 1 if a file is missing)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
const LIB = resolve('js/lib/three');
const seeds = new Set([resolve('js/lib/three/build/three.module.min.js')]);
const code = (n) => n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.html');
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (p !== LIB && e.name !== 'node_modules') scan(p); continue; }
    if (!code(e.name)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/three\/examples\/jsm\/([^'"]+)/g))
      seeds.add(join(LIB, 'examples/jsm', m[1]));
  }
})(resolve('.'));
const seen = new Set(), missing = [], queue = [...seeds];
while (queue.length) {
  const f = queue.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { missing.push(f); continue; }
  for (const m of src.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g))
    queue.push(resolve(dirname(f), m[1]));
}
if (missing.length) { console.error('MISSING:\n' + missing.join('\n')); process.exit(1); }
console.log('three closure OK:', seen.size, 'files');
```

**(b) Runtime positive signal.** Serve the folder statically (`npx serve`, or
`python3 -m http.server`) and load `index.html` in a browser. Check for a POSITIVE
signal that the entry module actually executed. Have the entry set a flag on its
last line:

```js
// end of js/main.js
window.__sandscape_entry_ok = true;
```

Then confirm `__sandscape_entry_ok` is `true` in the browser console. Do NOT rely
on "no console errors": a rejected module graph fails silently, so an absent
error is not proof the engine loaded.

## Ship rule

`node_modules/` stays out of the push (it is build-time only). `js/lib/three/`
SHIPS with the game. Never `.gitignore` `js/lib/`, or the published game dies
with import-map 404s.
