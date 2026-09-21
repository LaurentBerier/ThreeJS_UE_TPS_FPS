// level-export.js — the bridge from a running Three.js game to the Sandscape
// Level Editor. The counterpart of `level-import.js`: this one gets a level OUT
// of a running game, that one plays an edited one back.
//
// Use it for any game whose level is BUILT AT RUNTIME (laid out from code, no
// level file on disk). The only faithful way to "import the current level" is
// to let the game build it and then walk the live scene graph. That is what
// this module does: it reads the scene the game just assembled and returns a
// Sandscape scene document — Three.js native JSON (`Object3D.toJSON()`), the
// exact format `/api/scenes/save` stores and `THREE.ObjectLoader` reads back.
//
// The platform provisions this file into `<game>/js/sandscape/level-export.js`
// (the `capture_level` tool does it before every capture; `tools/sync-level-runtime.mjs`
// does it for a game repo). Never hand-port it — see the package README.
//
// It is deliberately additive and game-agnostic:
//   • nothing runs unless the page is opened with `?sandscape-export`
//   • it never mutates the live scene
//   • it imports NOTHING from the game — every game-specific input (height
//     function, markers, name) is injected through installLevelExport()
//
// Contract with the editor (see `docs/features/scene-editor.md` › Runtime contract):
//   • A GLB placement is an EMPTY Object3D carrying `userData.modelPath` (path
//     relative to the session's generated_assets/). The editor mounts the
//     loaded GLB underneath it as editor-only content, so the document stays
//     light and the wrapper transform is the authoritative placement.
//   • Lights and the reference camera are exported; UNTAGGED meshes are NOT —
//     this exporter emits tagged placements, lights, an optional terrain proxy
//     and markers. A game that builds its level from native geometry rather
//     than GLBs needs its own handling.
//   • Anything in `userData` survives the round trip and is editable in the
//     editor's Data tab.

let THREE = null;   // resolved at install time — see resolveThree()

const DEFAULT_MARK = 'sandscape';

// Placeholder ground colour, used only when the caller supplies no `terrain.color`.
// The proxy's userData records WHICH of the two it was (`colorSource`), because a
// game whose ground really is this olive must not be mistaken for one that never
// sampled its ground at all.
const DEFAULT_TERRAIN_COLOR = 0x6b7a3f;
// The key installLevelExport() was configured with. buildLevelDocument resolves
// the key it uses PER CALL, so a per-export `tagKey` override actually works
// and a second install cannot orphan the first install's tags.
let INSTALLED_MARK = DEFAULT_MARK;

/**
 * Games load three in different ways (import map, bundler alias, a global, a
 * vendored copy). Try the bare specifier, fall back to whatever the caller
 * handed us or to a global. Never top-level `import` it — that would make this
 * module fail to parse in a game that has no 'three' specifier.
 */
async function resolveThree(explicit) {
  if (explicit) return explicit;
  try {
    return await import('three');
  } catch {
    if (typeof window !== 'undefined' && window.THREE) return window.THREE;
    throw new Error(
      'level-export: could not resolve three. Pass it in: installLevelExport({ THREE, ... })',
    );
  }
}

/**
 * Tag a live object as level content that should be exported.
 * Call this on the node whose WORLD TRANSFORM is the placement of the GLB —
 * i.e. the scaled/grounded clone, not its parent group.
 *
 * @param {THREE.Object3D} node
 * @param {{modelPath: string, name?: string, game?: object}} info
 */
export function tagForExport(node, info) {
  // Both of these are silent data loss otherwise: the prop simply never appears
  // in the export and no count reflects it. `info.game` must be plain JSON —
  // userData is serialized by reference, so a Vector3 degrades to {x,y,z}, a Set
  // to {}, and a circular reference kills the headless capture outright.
  if (!node) {
    console.warn('[level-export] tagForExport called with no node — ignored.');
    return node;
  }
  if (!info || !info.modelPath) {
    console.warn(`[level-export] tagForExport("${node.name || 'unnamed'}") without a modelPath — ` +
      'this prop will NOT be exported.');
    return node;
  }
  node.userData[INSTALLED_MARK] = info;
  return node;
}

// ── Node builders ────────────────────────────────────────────────────────────

/**
 * Effective visibility: a node inside a hidden group is not on screen, and the
 * wrapper is flattened to world space so it would otherwise lose that and load
 * visible. Stops at the scene root.
 */
function visibleInWorld(node, root) {
  let current = node;
  while (current && current !== root) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Decompose a live node's world matrix onto a fresh empty wrapper.
 *
 * toJSON() serializes `matrix`, NOT position/quaternion/scale, and those are
 * only folded into `matrix` by updateMatrix() — which normally happens during a
 * render. An export document is never rendered, so every node built here must
 * update its own matrix or it ships an identity and the level stacks at the
 * origin at scale 1.
 */
function assetWrapper(node, root, mark) {
  const info = node.userData[mark];
  if (!info || !info.modelPath) return null;

  const wrapper = new THREE.Object3D();
  node.updateWorldMatrix(true, false);
  // Matrix4.decompose cannot invert a zero-determinant basis: it silently
  // returns scale (1,1,1) and an identity rotation. Games hide pooled or culled
  // objects with scale 0, so without this check they would export as full-size,
  // fully visible props.
  const degenerate = Math.abs(node.matrixWorld.determinant()) < 1e-12;
  node.matrixWorld.decompose(wrapper.position, wrapper.quaternion, wrapper.scale);
  wrapper.updateMatrix();

  wrapper.name = info.name || node.name || info.modelPath.split('/').pop();
  // Hidden variants (e.g. the inactive half of a swap pair) stay in the
  // document as authorable, invisible objects — the editor ghosts them.
  // Ancestors count: the wrapper is flattened to world space, so a node hidden
  // only by its parent group would otherwise come back visible.
  wrapper.visible = visibleInWorld(node, root) && !degenerate;
  wrapper.userData = {
    isAssetReference: true,
    modelPath: info.modelPath,
    assetName: info.name || wrapper.name,
    game: info.game || {},
    ...(degenerate ? { collapsedScale: true } : {}),
  };
  return wrapper;
}

/**
 * A coarse displaced plane standing in for a procedural terrain, sampled from
 * the game's own height function. Games that regenerate their ground every run
 * (vertex colours, canvas detail maps, chunked meshes) should not ship it
 * verbatim — this proxy exists so props sit on visible ground while editing.
 *
 * Skipped entirely when the caller passes no `heightAt`.
 */
function terrainProxy({ size, segments, heightAt, color, roughness, metalness, name, colorSource }) {
  const plane = new THREE.PlaneGeometry(size, size, segments, segments);
  plane.rotateX(-Math.PI / 2);
  const position = plane.attributes.position;
  // A heightAt that returns undefined/NaN outside the game's own bounds would
  // poison the buffer: JSON.stringify writes NaN as `null`, Float32Array turns
  // that back into 0, and the bounding sphere comes back null so the terrain
  // can be frustum-culled out of existence. Clamp to 0 instead.
  let nonFinite = 0;
  for (let i = 0; i < position.count; i++) {
    const y = heightAt(position.getX(i), position.getZ(i));
    if (Number.isFinite(y)) position.setY(i, y);
    else { position.setY(i, 0); nonFinite++; }
  }
  position.needsUpdate = true;
  plane.computeVertexNormals();

  // CRITICAL: a PlaneGeometry serializes as its PARAMETERS (width/height/
  // segments) and nothing else — ObjectLoader rebuilds a pristine flat plane in
  // the XY plane, silently discarding both the baked rotateX and every
  // displaced vertex. The terrain then loads VERTICAL and FLAT. Copying the
  // attributes into a plain BufferGeometry makes the real data round-trip.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', plane.getAttribute('position'));
  geometry.setAttribute('normal', plane.getAttribute('normal'));
  geometry.setIndex(plane.getIndex());
  geometry.computeBoundingSphere();
  plane.dispose();

  // A MeshStandardMaterial on purpose: it is what the editor's Material tab can
  // edit (it refuses Lambert/Phong/Basic), so the player can correct the ground
  // in place rather than living with whatever the capture guessed.
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      roughness: roughness ?? 1,
      metalness: metalness ?? 0,
    }),
  );
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.updateMatrix();
  mesh.userData.game = {
    role: 'terrain-proxy',
    note: 'Editing reference only — the game regenerates its real terrain each run. ' +
      'Untextured: no uv attribute, so assigning a mapped material renders it flat.',
    size,
    segments,
    // Whether the caller told us the ground's colour or we fell back to the
    // placeholder. A FACT, not a guess: the validator warns on 'default' so a
    // capture that never sampled the real ground says so, instead of shipping a
    // green field under a red desert and passing clean. A game whose ground
    // genuinely IS the placeholder olive would otherwise be indistinguishable.
    colorSource: colorSource || 'default',
    ...(nonFinite ? { nonFiniteSamples: nonFinite } : {}),
  };
  return mesh;
}

function markerNode(spec) {
  const node = new THREE.Object3D();
  node.name = spec.name || 'Marker';
  const p = spec.position || {};
  node.position.set(p.x || 0, p.y || 0, p.z || 0);
  if (spec.rotation) node.rotation.set(spec.rotation.x || 0, spec.rotation.y || 0, spec.rotation.z || 0);
  node.updateMatrix();
  node.userData.game = spec.data || {};
  return node;
}

/**
 * Markers are how gameplay data that has no mesh (spawn points, zones,
 * splines, triggers, waypoints) reaches the editor: empty Object3Ds carrying
 * `userData.game`, editable in the properties panel's Data tab and drawable
 * with the viewport's visualizers.
 *
 * @param {Array|Function} markers array of {name, position, rotation?, data} or
 *        a function returning one. Anything else is ignored.
 */
function markerGroup(markers, ctx) {
  const list = typeof markers === 'function' ? markers(ctx) : markers;
  if (!Array.isArray(list) || list.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'Markers';
  group.updateMatrix();
  for (const spec of list) {
    if (spec) group.add(markerNode(spec));
  }
  return group.children.length ? group : null;
}

/** Clone a light onto its composed world transform (it may sit inside a group). */
function lightClone(light) {
  // clone(false): Object3D.copy is recursive by default, which would bake any
  // helper/gizmo mesh parented to the light into the document as raw geometry.
  const clone = light.clone(false);
  light.updateWorldMatrix(true, false);
  light.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
  clone.updateMatrix();
  // Games set this on static lights for performance; ObjectLoader only
  // decomposes `matrix` back into position/rotation/scale when it is true, so
  // leaving it false makes the light unmovable in the editor (it reads 0,0,0
  // and teleports to the origin on the first edit).
  clone.matrixAutoUpdate = true;
  // Neither DirectionalLight.target nor SpotLight.target serializes. Record the
  // aim so it is at least visible in the Data tab — note that nothing in the
  // editor consumes it yet, so the light still renders aimed at the origin.
  if ((light.isDirectionalLight || light.isSpotLight) && light.target) {
    const t = light.target.getWorldPosition(new THREE.Vector3());
    clone.userData.game = { ...(clone.userData.game || {}), targetWorld: { x: t.x, y: t.y, z: t.z } };
  }
  return clone;
}

/**
 * decompose() cannot represent shear, which is what a rotated node under a
 * non-uniformly scaled ancestor produces. There is no fix (the editor's gizmo
 * needs TRS), but an undetected wrong-looking placement is exactly the class of
 * failure this exporter exists to avoid — so measure it and report it.
 */
function shearError(node, wrapper) {
  const recomposed = new THREE.Matrix4().compose(wrapper.position, wrapper.quaternion, wrapper.scale);
  let worst = 0;
  for (let i = 0; i < 16; i++) {
    worst = Math.max(worst, Math.abs(recomposed.elements[i] - node.matrixWorld.elements[i]));
  }
  return worst;
}

// ── Document assembly ────────────────────────────────────────────────────────

/**
 * Walk the live scene and produce a Sandscape scene document.
 *
 * @param {object} ctx
 * @param {THREE.Scene}  ctx.scene          the live game scene (required)
 * @param {THREE.Camera} [ctx.camera]       exported as a reference camera
 * @param {THREE.WebGLRenderer} [ctx.renderer] read for toneMappingExposure
 * @param {string}   [ctx.name]             scene name shown in the editor
 * @param {Function} [ctx.heightAt]         (x,z)=>y — enables the terrain proxy
 * @param {object}   [ctx.terrain]          {size, segments, color, roughness, metalness, name}
 * @param {object}   [ctx.environment]      {path, background} — the game's IBL/sky,
 *                                          written to doc.userData.rendering.environmentMap
 * @param {number|string} [ctx.background]  fallback background colour for a
 *                                          procedural sky that cannot be exported
 * @param {Array|Function} [ctx.markers]    gameplay markers (see markerGroup)
 * @param {object}   [ctx.metadata]         merged into doc.userData.game
 * @param {Function} [ctx.include]          (node)=>bool filter over tagged nodes
 * @param {Function} [ctx.includeLight]     (light)=>bool filter over harvested lights
 * @returns {{scene_data: object, stats: object}}
 */
export function buildLevelDocument(ctx) {
  const {
    scene, camera, renderer,
    name = 'Game Level',
    heightAt,
    terrain = {},
    environment,
    background,
    markers,
    metadata,
    include,
    includeLight,
  } = ctx;

  // Usable without installLevelExport() (e.g. from a test harness) as long as
  // three comes in with the context.
  if (!THREE) {
    if (!ctx.THREE) {
      throw new Error('level-export: three is not resolved — call installLevelExport() first, or pass { THREE }.');
    }
    THREE = ctx.THREE;
  }
  const mark = ctx.tagKey || INSTALLED_MARK;

  const doc = new THREE.Scene();
  doc.name = name;

  const dropped = [];
  if (scene.background && scene.background.isColor) doc.background = scene.background.clone();
  else if (scene.background) {
    // A texture background would embed as a data URL and bloat the document.
    // Reference it through userData.rendering.environmentMap instead.
    dropped.push('scene.background (texture — not embeddable; set userData.rendering.environmentMap.path)');
  }
  // A sky built as a shader dome (a big BackSide sphere with a custom
  // ShaderMaterial) is not a `scene.background` at all, and there is no way to
  // export it — it is untagged native geometry running code. A caller that has
  // one passes the horizon colour instead, so the editor shows the level under
  // something resembling its sky rather than against a black void.
  if (!doc.background && background !== undefined && background !== null) {
    doc.background = new THREE.Color(background);
  }
  // The IBL. `scene.environment` is a live PMREM render target — not
  // serializable, and pointless to try. What IS portable is the path the game
  // loaded it from, which is exactly the key the editor reads
  // (SceneEditor/sceneRendering.ts: userData.rendering.environmentMap).
  const envPath = (environment && typeof environment.path === 'string' && environment.path)
    ? environment.path
    : null;
  if (!envPath && scene.environment) {
    dropped.push('scene.environment (IBL — pass { environment: { path, background } } to keep the lighting)');
  }
  if (scene.fog) doc.fog = scene.fog.clone();

  const props = new THREE.Group();
  props.name = 'Props';
  props.updateMatrix();
  const lights = new THREE.Group();
  lights.name = 'Lights';
  lights.updateMatrix();

  const missing = [];
  const sheared = [];
  const instanced = [];
  let tagged = 0;
  let skipped = 0;
  let skippedLights = 0;

  // An explicit stack walk, NOT scene.traverse(): traverse ignores whatever the
  // callback returns and always recurses, so a tagged node's own subtree would
  // still be visited. That emits a duplicate placement for every nested tag and
  // harvests lights that live INSIDE a GLB (KHR_lights_punctual) — which the
  // editor then re-mounts with the model, doubling the light. A tagged node is
  // a leaf placement: claim it and stop.
  const stack = [scene];
  while (stack.length) {
    const node = stack.pop();

    if (node !== scene && node.userData && node.userData[mark]) {
      tagged++;   // counted before filtering: tagged === props + skipped + missing
      if (include && !include(node)) { skipped++; continue; }
      // Instancing collapses to a single wrapper at the InstancedMesh's own
      // transform — every instance would be lost. Surface it rather than
      // silently exporting one rock where the game drew five hundred.
      if (node.isInstancedMesh || node.isBatchedMesh) {
        instanced.push(`${node.name || '(unnamed)'} (${node.count ?? '?'} instances)`);
      }
      const wrapper = assetWrapper(node, scene, mark);
      if (wrapper) {
        const shear = shearError(node, wrapper);
        if (shear > 1e-4) sheared.push(`${wrapper.name} (${shear.toFixed(3)})`);
        props.add(wrapper);
      } else {
        missing.push(node.name || '(unnamed)');
      }
      continue;
    }

    // Clone rather than reparent so the running game is untouched. Light.copy()
    // carries the shadow camera settings, which serialize with the light.
    if (node !== scene && node.isLight) {
      // Games pool per-run lights (muzzle flashes, projectile glows, impact
      // bursts) and park them in the scene at intensity 0. Those are not level
      // content: without a filter they land in the document as a pile of dead
      // PointLights. `includeLight` is the light counterpart of `include` — a
      // game that tags its level lights can say which ones belong.
      if (includeLight && !includeLight(node)) { skippedLights++; continue; }
      const clone = lightClone(node);
      clone.visible = visibleInWorld(node, scene);
      lights.add(clone);
      continue;
    }

    for (const child of node.children) stack.push(child);
  }

  if (typeof heightAt === 'function') {
    doc.add(terrainProxy({
      size: terrain.size ?? 512,
      segments: terrain.segments ?? 64,
      color: terrain.color ?? DEFAULT_TERRAIN_COLOR,
      colorSource: terrain.color === undefined ? 'default' : 'caller',
      roughness: terrain.roughness,
      metalness: terrain.metalness,
      name: terrain.name ?? 'Terrain (proxy)',
      heightAt,
    }));
  }
  if (props.children.length) doc.add(props);
  if (lights.children.length) doc.add(lights);

  const markerNodes = markerGroup(markers, ctx);
  if (markerNodes) doc.add(markerNodes);

  if (camera && camera.isPerspectiveCamera) {
    // A first-person camera often carries a weapon model, HUD quads, an
    // AudioListener and sprites — all of which would otherwise be baked into
    // the document as raw geometry and embedded textures. clone(false) is NOT
    // enough: `Camera.prototype.clone` overrides Object3D's and takes NO
    // arguments (`return new this.constructor().copy(this)`), so the recursive
    // flag is silently ignored and the whole weapon rig comes along. Measured
    // on one FPS game: a 19.85 MB document, 17.6 MB of it embedded player-skin
    // PNGs. Detach explicitly — copy() pushed clones, so the originals are safe.
    const cam = camera.clone(false);
    cam.children.length = 0;
    camera.updateWorldMatrix(true, false);
    camera.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    cam.updateMatrix();
    cam.matrixAutoUpdate = true;
    cam.name = 'Game Camera';
    cam.userData.game = { role: 'gameplay-camera' };
    doc.add(cam);
  }

  doc.userData = {
    // Canonical editor key — the editor reads renderer exposure from here
    // because Three.js does not store it on the Scene.
    rendering: {
      toneMappingExposure: renderer ? renderer.toneMappingExposure : 1,
      // The editor's own key for a scene environment map, read by
      // SceneEditor/sceneRendering.ts as { path, background }. Note this rides
      // in `rendering`, NOT in `game` where ctx.metadata lands — a value merged
      // into the wrong one is silently ignored by the editor.
      ...(envPath
        ? { environmentMap: { path: envPath, background: environment.background === true } }
        : {}),
    },
    game: {
      source: 'runtime export',
      exportedAt: new Date().toISOString(),
      ...(metadata || {}),
    },
  };

  // Belt and braces for the matrix rule above: recompute the whole tree once
  // before serializing, covering anything built here.
  // NOTE for anyone extending this file: set position/quaternion/scale, never
  // assign `.matrix` directly. This sweep calls updateMatrix() on every node
  // with matrixAutoUpdate (the default), which recomposes from TRS and would
  // silently erase a hand-written matrix — reproducing the origin-stacking bug
  // this module's header warns about.
  doc.updateMatrixWorld(true);

  return {
    scene_data: doc.toJSON(),
    stats: {
      tagged,
      skipped,
      props: props.children.length,
      lights: lights.children.length,
      skippedLights,
      markers: markerNodes ? markerNodes.children.length : 0,
      terrain: typeof heightAt === 'function',
      missingModelPath: missing,
      // decompose() cannot carry shear; these placements are approximated.
      sheared,
      // Instanced sources collapse to one placement — every instance is lost.
      instanced,
      // The environment map reference the editor will light the scene with, or
      // null. Reported so a run can say whether the sky made it across instead
      // of the player discovering a black void.
      environmentMap: envPath
        ? { path: envPath, background: environment.background === true }
        : null,
      // Whether the ground colour was sampled from the game or left as the placeholder.
      terrainColorSource: typeof heightAt === 'function'
        ? (terrain.color === undefined ? 'default' : 'caller')
        : null,
      // Scene-level things this format cannot embed.
      dropped,
    },
  };
}

/**
 * Install the export hook. Call once, after the world has been built.
 * Sets `window.__sandscapeLevelReady` so headless capture knows when to ask.
 *
 * Async because three is resolved dynamically — `await` it, or just call it and
 * let the ready flag gate the capture.
 *
 * @param {object} ctx see buildLevelDocument, plus:
 * @param {object} [ctx.THREE]   pass three explicitly if `import('three')` fails
 * @param {string} [ctx.tagKey]  userData key used by tagForExport (default 'sandscape')
 */
export async function installLevelExport(ctx) {
  THREE = await resolveThree(ctx.THREE);
  INSTALLED_MARK = ctx.tagKey || DEFAULT_MARK;

  window.__sandscapeExportLevel = (overrides = {}) =>
    buildLevelDocument({ ...ctx, ...overrides });
  window.__sandscapeLevelReady = true;

  // Opened by hand in a browser with ?sandscape-export=download → save a file.
  if (new URLSearchParams(location.search).get('sandscape-export') === 'download') {
    const { scene_data } = window.__sandscapeExportLevel();
    const blob = new Blob([JSON.stringify(scene_data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'level.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
