// level-import.js — read a Sandscape Level Editor scene back into a running
// game. The counterpart to level-export.js.
//
// This is the game's **scene→runtime adapter** (docs/features/scene-editor.md,
// "Runtime contract"): the editor document is the source of truth for WHERE
// things are, and each game converts that into its own placements. Keeping the
// conversion in the game — rather than teaching the editor every engine's format —
// is what lets one authoring format serve every game.
//
// Design rules this module follows, and yours should too:
//   • FAIL SOFT. No scene file, a malformed one, a 404 or an offline load all
//     return null so the game builds its own level exactly as before. An editor
//     integration must never be the reason a game stops booting.
//   • CACHE-BUST. The editor rewrites the same path in place; a cached copy is
//     precisely how "my edit did not show up" happens.
//   • The editor transform is AUTHORITATIVE. It already contains the scale and
//     grounding offset the exporter captured — apply it, do not recompute it.
//   • APPLY `userData.contentOffset`. A wrapper's transform is the pivot of the
//     object's BOX, not the origin of the model that fills it. Skipping the offset
//     between the two places every prop at a corner of itself. See withContentOffset().
//
//   • USE applyPlacement(). Writing the three `.set()` calls by hand is how the
//     rotation gets silently rewritten — see the note on that function.
//   • AUDIT THE RESULT. auditImportedLevel() compares what the game actually
//     placed against what the document holds, and console.errors the mismatch.
//     A game whose own level builder still runs looks perfect until the player
//     moves something.
//
// It reads only what level-export.js writes: empty wrappers carrying
// `userData.modelPath` plus whatever `userData.game` the game tagged. The
// terrain proxy and marker objects are deliberately ignored — a proxy is an
// editing reference, and markers usually mirror constants the game already owns.

const DEFAULT_CANDIDATES = ['scenes/level.json'];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Audit tolerances. Both are far wider than float error and far narrower than a
// real defect: the rotation bug this catches produced tens of degrees, and a
// re-applied contentOffset produced metres.
const ROTATION_TOLERANCE_DEG = 1.0;
const POSITION_TOLERANCE = 0.05;

/** Multiply two column-major 4x4s, the layout three serializes. */
function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/**
 * Decompose a world matrix into position / quaternion / scale. Mirrors
 * THREE.Matrix4.decompose so this module needs no three import and can run in
 * a game that loads three any which way.
 */
function decompose(m) {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);

  // A negative determinant means one axis is mirrored; three assigns that to X.
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (det < 0) sx = -sx;

  if (!sx || !sy || !sz) return null;   // collapsed scale — nothing to place

  const r = [
    m[0] / sx, m[1] / sx, m[2] / sx,
    m[4] / sy, m[5] / sy, m[6] / sy,
    m[8] / sz, m[9] / sz, m[10] / sz,
  ];
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = r;

  const trace = m11 + m22 + m33;
  let qx, qy, qz, qw;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s; qx = (m32 - m23) * s; qy = (m13 - m31) * s; qz = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    qw = (m32 - m23) / s; qx = 0.25 * s; qy = (m12 + m21) / s; qz = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    qw = (m13 - m31) / s; qx = (m12 + m21) / s; qy = 0.25 * s; qz = (m23 + m32) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    qw = (m21 - m12) / s; qx = (m13 + m31) / s; qy = (m23 + m32) / s; qz = 0.25 * s;
  }

  return {
    position: { x: m[12], y: m[13], z: m[14] },
    quaternion: { x: qx, y: qy, z: qz, w: qw },
    scale: { x: sx, y: sy, z: sz },
  };
}

/**
 * Re-base a wrapper's world transform onto the MODEL's own origin.
 *
 * A placement wrapper is NOT pivoted at the model's origin. The editor pivots a structural piece at
 * the MIN CORNER of its nominal box and a free-standing one at its bottom centre, because that is
 * what makes grid placement and on-the-spot rotation work while authoring. The model is mounted as
 * a CHILD of the wrapper, offset back to its own origin, and that offset is recorded on the wrapper
 * as `userData.contentOffset` — in WRAPPER-LOCAL units, so the wrapper's scale applies to it.
 *
 * The model therefore lives at `wrapperWorld · translate(contentOffset)`. A consumer that places the
 * model on the wrapper transform alone lands it on the CORNER of the box it should fill, off by
 * `R · (S ∘ contentOffset)` — which a prop scaled up 5x turns into metres, not centimetres.
 *
 * Compose it as a local translation rather than adding a vector to the decomposed position: that is
 * what keeps it exact under rotation, non-uniform scale and nested groups, and it leaves the
 * placement's own rotation and scale untouched.
 *
 * No offset recorded means the wrapper WAS the model origin (a document written before the editor
 * had a pivot convention), and the identity this returns is exactly right for it.
 */
function withContentOffset(world, offset) {
  if (!Array.isArray(offset) || offset.length !== 3) return world;
  const [x, y, z] = offset;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return world;
  if (x === 0 && y === 0 && z === 0) return world;
  return multiply(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/**
 * Normalise a `userData.modelPath` into something the GAME can fetch.
 *
 * The Level Editor writes whatever URL IT loaded the model from, which for a
 * platform-hosted kit is absolute and machine-specific:
 *   http://localhost:8022/api/game/<session>/generated_assets/kits/<kit>/imported/Foo.glb
 * That resolves on the authoring box and nowhere else — not in a published
 * build, not on a teammate's machine, not when the backend moves port.
 *
 * Everything after `/generated_assets/` is exactly the game-relative path, and
 * the game is itself served from that directory (both through the platform's
 * /api/game/<session>/generated_assets/ mount and through serve.py), so the
 * relative form is correct under either. Paths that are already relative, or
 * absolute URLs from somewhere else entirely (a CDN), are handed back untouched.
 */
function normaliseModelPath(path) {
  if (typeof path !== 'string' || !path) return path;
  if (!/^https?:\/\//i.test(path)) return path;                  // already relative
  const marker = '/generated_assets/';
  const at = path.indexOf(marker);
  if (at < 0) return path;                                        // foreign absolute URL — leave it
  return path.slice(at + marker.length);
}

/**
 * Collect every asset placement with its composed world transform.
 * A placement is a leaf — the walk never descends into one.
 */
export function collectPlacements(root) {
  const out = [];
  const walk = (node, parentMatrix, parentVisible) => {
    if (!node || typeof node !== 'object') return;
    const local = Array.isArray(node.matrix) && node.matrix.length === 16 ? node.matrix : IDENTITY;
    const world = multiply(parentMatrix, local);
    const visible = parentVisible && node.visible !== false;

    const modelPath = normaliseModelPath(node.userData && node.userData.modelPath);
    if (modelPath) {
      const trs = decompose(withContentOffset(world, node.userData.contentOffset));
      if (trs) {
        const ud = node.userData || {};
        out.push({
          modelPath,
          assetName: ud.assetName || node.name || '',
          game: ud.game || {},
          visible,
          // Procgen KIT markers. The editor does NOT bake its UV mapping into the document — it
          // stores these and derives the mapping from them on every load (procgen/kitTexture.ts),
          // so a consumer that wants the surfaces to look like the editor has to carry them
          // through and do the same. See sandscape/kit-uv.js.
          kit: {
            procKind: typeof ud.procKind === 'string' ? ud.procKind : undefined,
            tileWorldSize: typeof ud.tileWorldSize === 'number' ? ud.tileWorldSize : undefined,
            // IMPORTED art carries its own UV atlas and must keep it.
            authoredUV: ud.authoredUV === true,
            canonicalAxis: ud.canonicalAxis,
            dims: ud.dims,
          },
          ...trs,
        });
      }
      return;
    }
    for (const child of node.children || []) walk(child, world, visible);
  };
  walk(root, IDENTITY, true);
  return out;
}

/**
 * OPTIONAL helper for games that place variant pairs (damaged/repaired,
 * day/night, before/after). The exporter writes each variant as its own
 * wrapper, so re-key them by gameplay identity plus ground position — which
 * survives a pair being moved in the editor, as long as both halves moved
 * together. A pair split apart simply becomes two single-variant entries.
 *
 * @param {Array}  placements from collectPlacements
 * @param {object} [opts]
 * @param {string} [opts.variantField='variant'] key inside userData.game
 * @param {string[]} [opts.identityFields] userData.game keys that must match
 * @param {string} [opts.primary] variant treated as the group anchor
 */
export function groupVariants(placements, opts = {}) {
  const {
    variantField = 'variant',
    identityFields = [],
    primary = null,
  } = opts;

  const groups = new Map();
  for (const p of placements) {
    const g = p.game || {};
    const key = [
      ...identityFields.map((f) => g[f] ?? `~${f}`),
      p.position.x.toFixed(2), p.position.z.toFixed(2),
    ].join('|');

    let entry = groups.get(key);
    if (!entry) {
      entry = { variants: {}, game: g, list: [] };
      groups.set(key, entry);
    }
    const variant = g[variantField] ?? 'default';
    entry.variants[variant] = p;
    entry.list.push(p);
    if (!entry.anchor || (primary && variant === primary)) entry.anchor = p;
  }
  return [...groups.values()];
}

/**
 * Scene-level extras the editor writes on the ROOT object: per-family surface overrides (the
 * Surface panel's "shift these UVs") and the procgen grid's cell size, which the flat surfaces
 * snap their tile to. Both are needed to reproduce the editor's mapping; neither is per-placement.
 *
 * Override families are keyed by assetId ("kit:<the URL the editor loaded>"), so the keys get the
 * same normalisation as modelPath — otherwise a document written on one host would never match.
 */
export function readSceneSurface(rootObject) {
  const ud = (rootObject && rootObject.userData) || {};
  const uvByModel = new Map();
  const families = (ud.sandscapeMaterialOverrides && ud.sandscapeMaterialOverrides.families) || {};
  for (const [key, entry] of Object.entries(families)) {
    if (!entry || !entry.uv) continue;
    const path = normaliseModelPath(String(key).replace(/^kit:/, ''));
    uvByModel.set(path, entry.uv);
  }
  // The texture knobs the editor was showing this scene with. They live in the document (not just
  // the editor's UI state), so a consumer can reproduce the same surfaces instead of guessing —
  // `triplanar`/`triplanarScale` in particular decide the on-screen tile size.
  const params = (ud.sandscapeProcgen
    && ud.sandscapeProcgen.layout
    && ud.sandscapeProcgen.layout.params) || {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const texture = {
    cellSize: num(params.cellSize, undefined),
    triplanar: params.triplanar !== false,
    // Passed through UNTOUCHED when absent: kit-uv.js owns the single fallback, and it MUST
    // equal DEFAULT_PROC_PARAMS.triplanarScale. Defaulting here to 8 (the pre-rebase value) made
    // that fallback unreachable in every real consumer — `applyWorldUVTiling` only uses its own
    // `: 4` when the field is missing, and this filled it in first — so a document that omits the
    // field rendered at DOUBLE the editor's tile density in game, silently. Guardrail #53.
    triplanarScale: num(params.triplanarScale, undefined),
    textureScale: num(params.textureScale, 1),
    uvDensity: num(params.uvDensity, 1),
    rotationRad: (num(params.textureRotation, 0) * Math.PI) / 180,
  };
  return { uvByModel, texture };
}

/**
 * Fetch and parse an edited level.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.candidates] paths to try, first hit wins
 * @param {string}   [opts.param='level'] query param for override / 'off'
 * @param {boolean}  [opts.quiet] suppress the console summary
 * @param {object}   [opts.scene] the live THREE.Scene. Pass it and the adapter is
 *        AUDITED automatically once the world has settled — see below
 * @param {number}   [opts.auditDelayMs=4000] how long to wait for the world
 * @returns {Promise<{placements: Array, doc: object, source: string,
 *                    uvByModel: Map<string, object>, texture: object}|null>}
 */
export async function loadEditedLevel(opts = {}) {
  const { param = 'level', quiet = false } = opts;
  const params = new URLSearchParams(location.search);
  const override = params.get(param);

  // An explicit escape hatch matters: it is how you A/B the imported level
  // against the game's own, and how you boot when a scene is broken.
  if (override === 'off') return null;

  const candidates = [override, ...(opts.candidates || DEFAULT_CANDIDATES)].filter(Boolean);

  for (const path of candidates) {
    let doc;
    try {
      const res = await fetch(`${encodeURI(path)}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) continue;
      doc = await res.json();
    } catch {
      continue;
    }

    if (!doc || !doc.object) {
      console.warn(`[level-import] ${path} is not a scene document — ignoring.`);
      continue;
    }

    const placements = collectPlacements(doc.object);
    if (!placements.length) {
      console.warn(`[level-import] ${path} has no asset placements — ignoring.`);
      continue;
    }

    const surface = readSceneSurface(doc.object);
    if (!quiet) console.log(`[level-import] ${path}: ${placements.length} placements`);
    const result = { placements, doc, source: path, uvByModel: surface.uvByModel, texture: surface.texture };

    // Audit the adapter WITHOUT the game having to remember to.
    //
    // `auditImportedLevel` exists because the two worst round-trip defects are
    // invisible — a level built twice overlaps itself, and a corrupted rotation
    // only shows on tilted props. But an audit the integrator has to call is an
    // audit that can simply not be called, which is exactly what happened the
    // first time this shipped: the run followed the instruction to branch the
    // builder and skipped the instruction to verify it. So loading the level is
    // enough to arm the check — this call already exists in every adapter.
    //
    // Deferred, because the world does not exist yet at this point: the whole
    // reason `loadEditedLevel` is awaited BEFORE the level is built is that the
    // builder needs its result. Timers are not exact, so a shortfall is reported
    // as a note rather than an error here (props may still be streaming in),
    // while a double-spawn and a wrong transform stay errors — neither of those
    // resolves itself with more time.
    if (opts.scene) {
      const delay = typeof opts.auditDelayMs === 'number' ? opts.auditDelayMs : 4000;
      setTimeout(() => {
        try {
          auditImportedLevel(opts.scene, result, { quiet, strict: false });
        } catch {
          // Never let the audit be the reason a game stops booting.
        }
      }, delay);
    }
    return result;
  }

  return null;   // nothing to import: the game builds its own level
}

/**
 * Apply a placement's transform to a runtime object — the ONE supported way.
 *
 * Use this instead of hand-writing the three `.set()` calls. The order of
 * operations here is not stylistic; getting it wrong silently rewrites the
 * rotation, and the result LOOKS like a successful import.
 *
 * The trap, which has shipped: assigning `obj.rotation.order` AFTER the
 * quaternion. `Quaternion.set()` fires three's `onQuaternionChange`, which does
 * `rotation.setFromQuaternion(q, undefined, false)` and decomposes into the
 * rotation's CURRENT order. Assigning `.order` afterwards then fires
 * `onRotationChange` → `quaternion.setFromEuler(rotation, false)`, which
 * re-reads those same angles under the NEW order and produces a DIFFERENT
 * rotation. A pure small yaw survives it, so a spot check passes; anything
 * tilted does not. One real import came out with 19 of 76 props mis-oriented,
 * the worst by 165°, and it read as new objects appearing in the level.
 *
 * So: set the order FIRST (via `opts.rotationOrder`) if the game needs one at
 * all, and let the quaternion be the last word.
 *
 * @param {object} obj   a THREE.Object3D
 * @param {object} p     one entry from `collectPlacements` / `loadEditedLevel`
 * @param {object} [opts]
 * @param {string} [opts.rotationOrder]  applied BEFORE the quaternion, never after
 * @returns {object} obj
 */
export function applyPlacement(obj, p, opts = {}) {
  if (!obj || !p) return obj;
  const { position: t, quaternion: q, scale: s } = p;
  // Before the quaternion — see above. Assigning it after is the bug this
  // helper exists to make unreachable.
  if (opts.rotationOrder && obj.rotation) obj.rotation.order = opts.rotationOrder;
  if (t) obj.position.set(t.x, t.y, t.z);
  if (q) obj.quaternion.set(q.x, q.y, q.z, q.w);
  if (s) obj.scale.set(s.x, s.y, s.z);
  // A game that turns off automatic matrix updates for static props has to ask
  // for the recompose explicitly, or the object renders at its previous transform.
  if (obj.matrixAutoUpdate === false && typeof obj.updateMatrix === 'function') {
    obj.updateMatrix();
  }
  return obj;
}

/**
 * Count what the running game ACTUALLY placed, and say so loudly when it does
 * not match the document.
 *
 * This exists because the most damaging way to get the round trip wrong is also
 * the most invisible. The adapter is supposed to REPLACE the game's own layout;
 * a game whose level builder still runs places both, and since almost every
 * imported prop lands exactly on top of its authored twin, the level looks
 * correct. Only the props the player actually MOVED in the editor show up
 * twice — so the bug surfaces days later, as "why are there three trees".
 *
 * The check is a count, not a diff: every placement the exporter wrote carries
 * `userData.sandscape`, and step 4c requires the adapter to re-tag the objects
 * it creates, so a healthy boot has exactly as many tagged nodes in the live
 * scene as the document has placements. Double that, and the built-in builder
 * is still running.
 *
 * A tag is a LEAF — the walk does not descend into one, matching the exporter's
 * own semantics (a prop's internal meshes are not placements).
 *
 * @param {object} scene       the live THREE.Scene (or any {children} tree)
 * @param {object|Array} imported  the `loadEditedLevel` result, or its placements
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] suppress the healthy-case log line
 * @returns {{tagged: number, expected: number, status: 'ok'|'double-spawn'|'short'}}
 */
export function auditImportedLevel(scene, imported, opts = {}) {
  const placements = Array.isArray(imported) ? imported : ((imported && imported.placements) || []);
  const expected = placements.length;
  const strict = opts.strict !== false;

  // Every tagged node in the live scene, with the WORLD transform it ended up
  // with. A tag is a leaf, matching the exporter's own walk.
  const live = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const ud = node.userData;
    if (ud && (ud.sandscape || ud.modelPath)) {
      const el = node.matrixWorld && node.matrixWorld.elements;
      const trs = el && el.length === 16 ? decompose(Array.from(el)) : null;
      live.push(trs);
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(scene);
  const tagged = live.length;

  let status = 'ok';
  if (expected > 0 && tagged > expected) {
    status = 'double-spawn';
    console.error(
      `[level-import] DOUBLE-SPAWN: ${tagged} tagged nodes in the scene vs ` +
      `${expected} placements in the document. The game's own level builder is ` +
      `still running alongside the imported level — branch it so it does not ` +
      `run, rather than placing the imported props on top of it. Props the ` +
      `player moved in the editor will appear twice.`,
    );
  } else if (expected > 0 && tagged < expected && strict) {
    status = 'short';
    console.error(
      `[level-import] SHORT PLACEMENT: ${tagged} tagged nodes in the scene vs ` +
      `${expected} placements in the document. ${expected - tagged} placement(s) ` +
      `were not created — an unresolved asset key, or an early return in the ` +
      `placement loop. Either re-tag the objects the adapter creates, or fix the ` +
      `lookup; do not report the import as complete.`,
    );
  }

  // Did the transforms SURVIVE being applied? Counting alone cannot tell —
  // a level with a perfect count can still be built wrong, and the way it goes
  // wrong is silent: assigning `rotation.order` after `quaternion.set()` makes
  // three re-read the decomposed angles under the new order, which changes the
  // rotation for anything not on a single axis. A pure yaw is unaffected, so a
  // spot check passes and only tilted props are wrong. Comparing what the game
  // BUILT against what the document ASKED FOR catches that however the adapter
  // wrote the transform — which is the point, since the helper meant to prevent
  // it can simply not be used.
  const drift = { rotated: 0, moved: 0, worstDeg: 0, worstMetres: 0 };
  try {
    const used = new Set();
    for (const p of placements) {
      // Match on POSITION: a corrupted rotation leaves the position correct, so
      // the nearest node is still unambiguously the same prop.
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < live.length; i++) {
        if (!live[i] || used.has(i)) continue;
        const d = Math.hypot(
          live[i].position.x - p.position.x,
          live[i].position.y - p.position.y,
          live[i].position.z - p.position.z,
        );
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) continue;
      used.add(best);
      if (bestD > POSITION_TOLERANCE) {
        drift.moved++;
        if (bestD > drift.worstMetres) drift.worstMetres = bestD;
        continue;                       // too far to judge its rotation against
      }
      const q = live[best].quaternion;
      const dot = Math.abs(q.x * p.quaternion.x + q.y * p.quaternion.y
        + q.z * p.quaternion.z + q.w * p.quaternion.w);
      const deg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      if (deg > ROTATION_TOLERANCE_DEG) {
        drift.rotated++;
        if (deg > drift.worstDeg) drift.worstDeg = deg;
      }
    }
  } catch {
    // An audit must never be the reason a game stops booting.
  }

  if (drift.rotated) {
    status = status === 'ok' ? 'wrong-transform' : status;
    console.error(
      `[level-import] WRONG ROTATION: ${drift.rotated} of ${expected} placements ` +
      `are built at a different rotation than the document asks for (worst ` +
      `${drift.worstDeg.toFixed(1)}°). The usual cause is assigning ` +
      `\`rotation.order\` AFTER \`quaternion.set()\`, which makes three re-read the ` +
      `decomposed Euler angles under the new order — a pure yaw survives it, so ` +
      `most props look right. Apply the transform with \`applyPlacement()\` from ` +
      `this module instead of writing the .set() calls by hand.`,
    );
  }
  if (drift.moved) {
    status = status === 'ok' ? 'wrong-transform' : status;
    console.error(
      `[level-import] WRONG POSITION: ${drift.moved} of ${expected} placements ` +
      `are built somewhere other than where the document puts them (worst ` +
      `${drift.worstMetres.toFixed(2)}m). Do not re-apply ` +
      `\`userData.contentOffset\` — this module has already applied it — and do ` +
      `not add the game's own grounding offset on top of the editor transform.`,
    );
  }

  if (status === 'ok' && !opts.quiet) {
    console.log(`[level-import] parity ok: ${tagged} placed, ${expected} in the document, transforms match.`);
  }

  return { tagged, expected, status, rotated: drift.rotated, moved: drift.moved };
}
