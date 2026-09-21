# Sandscape Create — reference

Copy-ready scaffolding for a new **Three.js** game structured for Sandscape's
static hosting. The skill body (SKILL.md) has the reasoning and the rules; this
file is the concrete starting point. Adapt names and content — keep the
`js/lib/three/` paths, the relative import map, and relative asset URLs.

## Vendoring script

Run once at the project root to fetch and vendor the engine. Node is used here at
BUILD time only; the game ships the copied files, not `node_modules/`.

```bash
#!/usr/bin/env bash
set -euo pipefail
[ -f package.json ] || npm init -y >/dev/null 2>&1
npm install three@0.185.1
mkdir -p js/lib/three/build js/lib/three/examples
cp node_modules/three/build/three.module.min.js js/lib/three/build/
cp node_modules/three/build/three.core.min.js   js/lib/three/build/
rm -rf js/lib/three/examples/jsm
cp -r node_modules/three/examples/jsm js/lib/three/examples/jsm
node -p "'three r'+require('three/package.json').version" > js/lib/three/VERSION
echo "vendored three into js/lib/three/"
```

## `.gitignore` (keep the engine, drop node_modules)

```gitignore
node_modules/
*.log
.DS_Store
# Do NOT ignore js/lib/ — the vendored engine must be pushed with the game.
```

If you keep a build/staging dir for a bundled project, ignore that too — but never
the served root and never `js/lib/three/`.

## `index.html`

Relative import map + module entry. Absolute paths break once served from the CDN.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Game</title>
  <link rel="stylesheet" href="css/style.css">
  <script type="importmap">
  {
    "imports": {
      "three": "./js/lib/three/build/three.module.min.js",
      "three/examples/jsm/": "./js/lib/three/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <script type="module" src="js/main.js"></script>
</body>
</html>
```

## `js/main.js` — a first playable

A rotating cube proves the engine, the import map and the render loop before you
add anything. Keep modules small and single-purpose (lighting, world, player,
input) as the game grows.

```javascript
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.5, 4);

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(3, 5, 2);
scene.add(key);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({ color: 0x5b8cff, roughness: 0.4 })
);
scene.add(cube);

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((t) => {
  cube.rotation.y = t / 1000;
  renderer.render(scene, camera);
});
```

## `css/style.css`

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #0b0e14; }
canvas { display: block; }
```

## Loading a model (cross-origin-safe from day one)

Published assets are served cross-origin from the CDN, so set anonymous CORS on
the loader now — it is a no-op locally and required in production. Use a relative
path; the injected `<base href>` resolves it to the CDN.

```javascript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
loader.setCrossOrigin('anonymous');
loader.load('models/ship.glb', (gltf) => {
  scene.add(gltf.scene);
}, undefined, (err) => {
  console.error('model failed to load', err);   // fall back in gameplay terms
});
```

For images read back through a canvas (`getImageData`/`toDataURL`/WebGL upload),
set `img.crossOrigin = 'anonymous'` **before** `img.src`. For a classic Worker,
fetch the source anonymously, wrap it in a `Blob`, and start from a `blob:` URL —
a CDN-origin script cannot start a same-origin classic worker. These rules and
why they matter are in the **sandscape-cli** skill's *Published runtime contract*.

## Checklist before `sandscape init`

- [ ] `index.html` at the served root, with the relative import map.
- [ ] `js/lib/three/build/three.module.min.js` **and** `three.core.min.js` present.
- [ ] `js/lib/three/examples/jsm/` present (full tree) if you use any addon.
- [ ] Every asset/URL is relative — no leading slashes.
- [ ] `.gitignore` ignores `node_modules/` but **not** `js/lib/`.
- [ ] The game runs from a plain static server locally.
- [ ] Then hand to **sandscape-cli** (`init` → `push` → publish) and
      **sandscape-assets** (real art/audio).
