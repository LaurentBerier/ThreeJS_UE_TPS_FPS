// kit-uv.js — the Sandscape Level Editor's world-proportional UV mapping for procgen KIT pieces.
//
// THIS FILE IS THE CANONICAL COPY. Games do not hand-port it: `tools/sync-level-runtime.mjs`
// installs it into a game's `js/sandscape/`, and the editor is pinned to it by the parity test
// `apps/client/src/components/SceneEditor/__tests__/kitUvParity.test.ts`, which fails if this
// module and `procgen/kitTexture.ts` ever stop producing identical UVs. Edit the mapping in BOTH
// or the test tells you which one you forgot.
//
// WHY THIS EXISTS. A kit GLB is a textured UNIT BOX. The editor scales one to each blockout
// piece's world dims — a wall run can be 20x longer than it is thick — so the box's plain baked
// per-face UVs get STRETCHED to that aspect: one smeared copy of the panel across a whole wall.
// The editor never shows those baked UVs; `procgen/kitTexture.applyWorldUVTiling` rewrites the uv
// attribute from WORLD position so every texel covers a fixed world area, and it flips U per face
// side so opposing faces don't read mirrored.
//
// The game was importing only the editor's TRANSFORMS, so it rendered the raw baked UVs: art
// stretched over each piece and reversed on one side of every wall — the reported "assets are
// upside down in game but fine in the editor". The mapping has to live on BOTH sides, because the
// editor deliberately does not bake it into the document (the scene stores the piece markers —
// procKind / tileWorldSize / dims — and each consumer derives the mapping from them).
//
// KEEP IN SYNC with apps/client/src/components/SceneEditor/procgen/kitTexture.ts. The two
// handedness signs below must also match macroShader.triplanarSample's, or the art flips when the
// editor's Triplanar Tiling toggle is used.
//
// THREE IS INJECTED, not imported. A bare `three` specifier would have to resolve identically in
// every consumer — a game (importmap), the editor (node_modules), a test runner — and any that
// resolved it separately would get a SECOND three instance, which the games' index.html already
// calls out as the thing to avoid (instanceof checks and shared constants stop matching across
// copies). Handing in the caller's THREE makes one instance structural rather than a convention.

// Pieces whose kit box gets world-proportional tiling.
const STRUCTURAL = new Set([
  'floor', 'wall', 'corridor_wall', 'arena_wall', 'ceiling', 'beam', 'trim', 'column', 'pillar',
])
// The big FLAT surfaces are WORLD-anchored so co-planar neighbours share one tiling phase (no seam
// at every piece boundary). Thin members stay LOCALLY anchored so each reads centred and identical
// to its siblings.
const WORLD_ANCHOR = new Set(['floor', 'wall', 'corridor_wall', 'arena_wall', 'ceiling'])
// Only FLAT, world-tiling surfaces get triplanar in the editor. When it is ON, the editor forces
// the UV maps to the SAME world tile the shader samples the albedo at, so colour and relief stay
// locked — which makes that tile, not the per-family one, the size the editor actually shows.
const TRIPLANAR_KINDS = new Set(['floor', 'wall', 'corridor_wall', 'arena_wall', 'ceiling'])
const TILE_WORLD_SIZE = 4
// Per-kind metres-per-repeat, used only when the asset carries no per-family tileWorldSize.
const KIND_TILE_WORLD = { ceiling: 8, floor: 6, beam: 2.8, trim: 4, column: 2.4, pillar: 2.4 }
// The kit box is 24 verts; a real image->3D mesh is thousands. Never re-UV those.
const MAX_BOX_VERTS = 64

/** Metres per full texture repeat for a piece: per-family size, else the per-kind override. */
export function assetTileWorld(procKind, tileWorldSize) {
  if (!procKind) return TILE_WORLD_SIZE
  return tileWorldSize > 0 ? tileWorldSize : (KIND_TILE_WORLD[procKind] ?? TILE_WORLD_SIZE)
}

/**
 * Snap a world tile so a WHOLE number of repeats spans one procgen cell. The flat surfaces bake a
 * DESIGNED panel, not a seamless micro-pattern, so every repeat boundary is a visible panel edge;
 * those only read as intentional joints when they land on the structural grid.
 */
export function snapTileToCell(tile, cellSize) {
  if (!(cellSize > 0) || !(tile > 0)) return tile
  return cellSize / Math.max(1, Math.round(cellSize / tile))
}

/**
 * Bind the mapping to a caller's THREE. Returns the surface functions; the pure-maths helpers
 * (`assetTileWorld`, `snapTileToCell`, `contentYaw`) need no THREE and are exported directly.
 *
 *   import * as THREE from 'three'
 *   const { applyWorldUVTiling, applyUVOverride } = createKitUV(THREE)
 */
export function createKitUV(THREE) {

/**
 * Re-UV a kit structural box so its maps tile by WORLD size. No-op for non-structural pieces,
 * non-box geometry, or materials with no base-color map.
 *
 * `model`'s world matrix must be current — the mapping reads getWorldScale/getWorldPosition.
 */
function applyWorldUVTiling(model, procKind, tileWorldSize, params) {
  if (!procKind || !STRUCTURAL.has(procKind)) return
  const P = params || {}
  const cellSize = P.cellSize
  const textureScale = P.textureScale > 0 ? P.textureScale : 1
  const uvDensity = P.uvDensity > 0 ? P.uvDensity : 1
  // TILE SIZE. With Triplanar Tiling on (the editor's default) the albedo is world-sampled at
  // `triplanarScale x textureScale` and every UV map is forced to that same tile — so THAT is the
  // size on screen, not the per-family `tileWorldSize`. Reading the per-family size instead gave
  // three panels per cell where the editor shows one. Same clamp as the shader's, or the albedo
  // and the normal/AO UVs would land on different tiles.
  // This fallback MUST equal DEFAULT_PROC_PARAMS.triplanarScale (guardrail #53). It fires for a
  // document that omits the field, and the editor renders that same document through
  // `{ ...DEFAULT_PROC_PARAMS, ...layout.params }`, so the editor's effective value IS the current
  // default — whatever that default happens to be. It was 8 while the default was 8; it is 4 since
  // the 2026-08-25 character-scale rebase. Snapping does NOT paper over a mismatch: 8 and 4 agree
  // only up to cellSize 5.5, and at cellSize 6 they snap to 6 m vs 3 m — a 2x density split between
  // the game and the editor, silent as always. Covered by the "legacy doc" cases in
  // __tests__/kitUvParity.test.ts, which run at a cell size where the two would diverge.
  const overrideTile = (P.triplanar && TRIPLANAR_KINDS.has(procKind))
    ? Math.max(0.25, (P.triplanarScale > 0 ? P.triplanarScale : 4) * textureScale)
    : 0
  const rawTile = overrideTile > 0
    ? overrideTile
    : Math.max(0.25, (assetTileWorld(procKind, tileWorldSize) * textureScale) / uvDensity)
  // The flat surfaces bake a DESIGNED panel whose repeat boundary is a visible edge, so it has to
  // land on a cell edge; the thin members are seamless cladding and snapping would only coarsen them.
  const tile = WORLD_ANCHOR.has(procKind) ? snapTileToCell(rawTile, cellSize) : rawTile
  const rot = P.rotationRad || 0
  const cosR = Math.cos(rot)
  const sinR = Math.sin(rot)
  model.updateWorldMatrix(true, true)

  const scale = new THREE.Vector3()
  const wpos = new THREE.Vector3()
  const anchor = WORLD_ANCHOR.has(procKind)
  model.traverse(obj => {
    const mesh = obj
    if (!mesh.isMesh || !mesh.geometry) return
    const geom = mesh.geometry
    const pos = geom.getAttribute('position')
    if (!pos || pos.count > MAX_BOX_VERTS) return          // skip 3D meshes / props

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const maps = materials.filter(m => m && m.map).flatMap(m =>
      [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap].filter(Boolean))
    if (!maps.length) return                                // nothing textured to tile

    // The kit box ships without a NORMAL accessor; compute per-face normals (it is unwelded, so
    // each vertex belongs to exactly one face => its computed normal IS that face's).
    if (!geom.getAttribute('normal')) geom.computeVertexNormals()
    const nor = geom.getAttribute('normal')

    mesh.getWorldScale(scale)
    if (anchor) mesh.getWorldPosition(wpos); else wpos.set(0, 0, 0)

    // BAND mapping (trim only): a ~0.12 m skirting is too thin for square texels, so map the thin
    // cross-section to the FULL texture and tile the long axis by world length.
    const band = procKind === 'trim'
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      const nxs = nor.getX(i), nys = nor.getY(i), nzs = nor.getZ(i)
      const nx = Math.abs(nxs), ny = Math.abs(nys), nz = Math.abs(nzs)
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i)
      let u, v
      if (band) {
        if (nx >= ny && nx >= nz) {
          if (scale.y <= scale.z) { v = py + 0.5; u = (pz * scale.z) / tile }
          else { v = pz + 0.5; u = (py * scale.y) / tile }
        } else if (ny >= nx && ny >= nz) {
          if (scale.x <= scale.z) { v = px + 0.5; u = (pz * scale.z) / tile }
          else { v = pz + 0.5; u = (px * scale.x) / tile }
        } else {
          if (scale.y <= scale.x) { v = py + 0.5; u = (px * scale.x) / tile }
          else { v = px + 0.5; u = (py * scale.y) / tile }
        }
      } else if (nx >= ny && nx >= nz) {
        // +/-X face -> across Z (length) and Y (height). HANDEDNESS: one projection serves a face
        // AND the face opposite it, so running U along +Z for both makes one side read MIRRORED —
        // invisible on a seamless material, glaring on graffiti. The sign is the standard triplanar
        // flip, sign(n.x) for the X projection and -sign(n.z) for Z.
        u = ((nxs < 0 ? -1 : 1) * (wpos.z + pz * scale.z)) / tile
        v = (wpos.y + py * scale.y) / tile
      } else if (ny >= nx && ny >= nz) {
        // +/-Y face (floor/ceiling) -> across X and Z. Left un-handed on purpose: straight down has
        // no canonical "right", so there is no correct side to mirror to.
        u = (wpos.x + px * scale.x) / tile
        v = (wpos.z + pz * scale.z) / tile
      } else {
        // +/-Z face -> across X (length) and Y (height). Same rule, opposite sign.
        u = ((nzs < 0 ? 1 : -1) * (wpos.x + px * scale.x)) / tile
        v = (wpos.y + py * scale.y) / tile
      }
      // V runs with world Y (three's v-up sense), NOT the glTF v-down sense the kit's own baked
      // UVs use. That is deliberate and load-bearing: the kit bakes its face texture stored
      // upside down, so the baked v-down UVs draw it inverted and this mapping is what turns it
      // back up. Negating V here to "match the glTF convention" flips every wall — it was tried.
      if (rot !== 0 && !band) {
        const ur = u * cosR - v * sinR
        v = u * sinR + v * cosR
        u = ur
      }
      uv[i * 2] = u
      uv[i * 2 + 1] = v
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2))

    for (const map of maps) {
      // DIVERGENCE FROM THE EDITOR, on purpose: kitTexture.ts takes a `preserveSampler` option and
      // leaves wrap/repeat alone when a piece is showing a library material the user is editing in
      // the Material Editor. A game has no Material Editor and no shared material library, so the
      // sampler is always neutralised here. This is the ONE thing the parity test cannot see — it
      // compares uv attributes, not sampler state — so it is stated rather than left to be found.
      // Tiling now lives in the UVs, so every map just needs REPEAT wrap and a neutral sampler.
      // The texture is SHARED across every clone of this kit family and they all want the same
      // values, so this is applied once per texture rather than per placement.
      if (map.wrapS === THREE.RepeatWrapping && map.wrapT === THREE.RepeatWrapping) continue
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.repeat.set(1, 1)
      map.offset.set(0, 0)
      map.center.set(0, 0)
      map.rotation = 0
      map.needsUpdate = true
    }
  })
}

/**
 * A per-family UV override from the editor's Surface panel ({offset, scale}), applied LAST so it
 * composes on top of whatever mapping the placement ended up with. Rewrites the per-placement uv
 * attribute rather than the shared sampler, so one family's tweak cannot leak into another's.
 */
function applyUVOverride(model, uvOverride) {
  if (!uvOverride) return
  const [ou, ov] = uvOverride.offset || [0, 0]
  const [su, sv] = uvOverride.scale || [1, 1]
  if (![ou, ov, su, sv].every(Number.isFinite)) return
  if (ou === 0 && ov === 0 && su === 1 && sv === 1) return
  model.traverse(obj => {
    const mesh = obj
    if (!mesh.isMesh || !mesh.geometry) return
    const attr = mesh.geometry.getAttribute('uv')
    if (!attr || attr.itemSize < 2) return
    // A FRESH Float32 attribute, never an in-place edit: a glTF may store UVs as a normalized
    // ushort accessor, where setXY renormalizes into [0,1] and CLAMPS, silently dropping any
    // scale above 1. This also detaches an interleaved buffer.
    const next = new Float32Array(attr.count * 2)
    for (let i = 0; i < attr.count; i++) {
      next[i * 2] = attr.getX(i) * su + ou
      next[i * 2 + 1] = attr.getY(i) * sv + ov
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(next, 2))
  })
}

  return { applyWorldUVTiling, applyUVOverride }
}

/**
 * The yaw (about local Y) that seats a canonicalized GLB inside a piece whose LOCAL nominal box is
 * `dims`. Always 0 or +90 degrees — see procgen/kitOrientation.ts.
 *
 * An imported kit GLB is baked with its thinnest extent on a known axis (wall/door -> X), but the
 * blockout is not: a vertical run is emitted thin in X and a horizontal one thin in Z, neither with
 * a yaw of its own. So half the pieces need the asset turned a quarter turn to seat correctly.
 * A quarter turn is safe under the wrapper's NON-UNIFORM scale (for a signed permutation P and
 * diagonal S, S*P === P*S'), which is why it can never be an arbitrary angle.
 */
export function contentYaw(canonicalAxis, dims) {
  if (!canonicalAxis || !dims) return 0
  const SQUARENESS = 0.9                                    // near-square pieces must resolve to 0
  if (canonicalAxis === 'x') return dims.d < dims.w * SQUARENESS ? Math.PI / 2 : 0
  if (canonicalAxis === 'z') return dims.w < dims.d * SQUARENESS ? Math.PI / 2 : 0
  return 0                                                  // 'y' can never be fixed by a Y yaw
}
