import * as THREE from 'three'

// The single source of truth for the NEW level: a deliberate journey across a dark sci-fi desert
// toward a colossal ruined castle, ending in the boss arena on its summit.
//
// This file is pure DATA + MATH — no scene objects, no physics, no three-pathfinding. It authors:
//
//   * the PATH SPINE: a polyline from the start overlook to the castle summit, with per-waypoint
//     ground height, corridor width and flanking-wall ("bund") amplitude. The terrain heightfield
//     is synthesised FROM this spine, so the route is walkable by construction — grades never
//     exceed what the player capsule and the AI ride comfortably;
//   * the ARENAS: flat combat pockets stamped into the terrain (basin, ruins, wreck field, gate
//     courtyard, summit) sized against the soldiers' measured perception/engagement envelope
//     (sight ≈ 28–34 m, hearing 32 m, held range 11–18 m — see UeSoldierController);
//   * SIDE PATHS: optional spurs with rewards / overwatch positions, wired into the walkable set;
//   * the CASTLE anchor (hill + summit arena) and every SPAWN (player, soldiers, beasts, boss,
//     ammo), each expressed as x/z only — Y always comes from Terrain.HeightAt at spawn time, the
//     same contract the old level used.
//
// Everything is DETERMINISTIC (seeded LCG, no Math.random): the world must be identical on every
// load or landmarks aren't landmarks and regressions can't be traced.
//
// GEOGRAPHY. The journey runs INTO the sunset: the castle sits on the sun's bearing (azimuth -118°
// — see DesertLook.SUN_AZIMUTH), so the whole walk is backlit, the fortress reads as a molten-edged
// silhouette from the first vista, and simply "walking toward the light" is the navigation rule.
// World footprint: a 640 m square centred on (0,0). Start overlook in the +x/+z corner, castle hill
// in the -x/-z corner, ~600 m apart; the authored path between them is ~800 m with switchbacks.

// ---------------------------------------------------------------------------------------------
// World footprint (consumed by Terrain + FarWorld + the navmesh generator).
// ---------------------------------------------------------------------------------------------
export const WORLD = {
    size: 640,           // metres per side, centred on (0,0)
    half: 320,
    gridN: 257,          // heightfield samples per side (2.5 m cells)
    seg: 256,            // terrain render/collider grid segments per side
    rim: -1.2,           // height the terrain settles to at its outer edge (FarWorld pad sits below)
}

// The castle. hill: where the mount rises. arena: the summit boss bowl (flat floor, ringed by the
// castle itself). gateway: the fortified courtyard on the shoulder below it.
export const CASTLE = {
    x: -152, z: -258,
    // Face the approach: local +Z points from the keep back toward the gate courtyard.
    yaw: Math.atan2(14, 32),
    arena: { x: -146, z: -266, r: 19, floor: 56 },
    // Where the drop-in lip sits (the arena entrance). It is placed just OUTSIDE the arena's flat
    // stamp (20.6 m from the arena centre vs r=19, feather 1.4), so the stamp carves a ~3 m ledge
    // between the lip crest and the bowl floor: crossing it commits the player — the drop cannot
    // be jumped back up, and the slope cut splits the navmesh so the boss lives on its own island.
    // That is what makes the arena boundary mechanically reliable without one invisible wall.
    lip: { x: -138, z: -247, h: 59.0 },
    gate: { x: -139.5, z: -232, yaw: Math.atan2(14, 32) },
}

// ---------------------------------------------------------------------------------------------
// The path spine. x/z: waypoint. h: trail ground height. w: corridor half-width (m). wall: how
// high the flanking dune/rock bunds rise beside the trail (the "natural barrier" amplitude — 0
// where a vista should open up, high where the route should feel cut through rock).
// ---------------------------------------------------------------------------------------------
const SPINE = [
    { x: 150, z: 258, h: 34.0, w: 10.0, wall: 0 },     // START overlook plateau — the opening vista
    { x: 128, z: 236, h: 26.0, w: 7.0,  wall: 0 },     // descent ramp off the scarp (walls open —
    { x: 108, z: 210, h: 14.0, w: 8.0,  wall: 4 },     //  nothing may block the first castle shot)
    { x: 96,  z: 182, h: 6.0,  w: 16.0, wall: 8 },     // BASIN arena — first contact
    { x: 66,  z: 156, h: 9.0,  w: 9.0,  wall: 12 },    // winding dunes
    { x: 34,  z: 140, h: 13.0, w: 7.0,  wall: 3 },     // saddle crest — castle re-revealed
    { x: 10,  z: 116, h: 5.0,  w: 12.0, wall: 10 },
    { x: -6,  z: 92,  h: 2.0,  w: 15.0, wall: 14 },    // RUINS arena — buried arches
    { x: -26, z: 64,  h: 5.0,  w: 6.0,  wall: 18 },    // canyon mouth — walls climb
    { x: -42, z: 40,  h: 8.0,  w: 4.5,  wall: 26 },    // canyon narrows (ruined bridge overhead)
    { x: -58, z: 22,  h: 10.0, w: 5.0,  wall: 22 },    // canyon exit — ambush
    { x: -76, z: 2,   h: 6.0,  w: 14.0, wall: 10 },    // WRECK FIELD arena — hulks + the first beast
    { x: -95, z: -38, h: 10.0, w: 10.0, wall: 7 },     // foothill approach — the castle looms
    { x: -112, z: -76, h: 16.0, w: 8.0, wall: 10 },
    { x: -148, z: -102, h: 24.0, w: 6.0, wall: 13 },   // switchback A
    { x: -108, z: -132, h: 32.0, w: 6.0, wall: 13 },   // switchback B — overlook spur joins here
    { x: -146, z: -168, h: 40.0, w: 6.0, wall: 11 },   // switchback C
    { x: -136, z: -204, h: 47.0, w: 8.0, wall: 6 },    // upper shoulder
    { x: -138, z: -226, h: 50.0, w: 12.0, wall: 0 },   // GATE courtyard
    { x: -139, z: -238, h: 54.5, w: 5.0, wall: 0 },    // final ascent through the gate
    { x: -138, z: -247, h: 59.0, w: 4.5, wall: 0 },    // arena entrance crest (the drop-in lip)
    { x: -146, z: -266, h: 56.0, w: 14.0, wall: 0 },   // SUMMIT boss arena
]

// Optional side paths: each is its own mini-spine whose FIRST point sits on (or beside) the main
// trail, so the walkable surfaces connect. Rewards / overwatch at the far end.
const BRANCHES = [
    // Ruins overwatch ledge: climbs east out of the ruins approach to a shelf with a clean firing
    // line down into the arena. Reward + advantage.
    [ { x: 10, z: 116, h: 5.0, w: 6.0, wall: 0 },
      { x: 24, z: 105, h: 8.0, w: 4.0, wall: 5 },
      { x: 34, z: 95,  h: 11.0, w: 6.0, wall: 6 } ],
    // Canyon alcove: a dead-end pocket gouged into the canyon's west wall. Ammo cache in the dark.
    [ { x: -42, z: 40, h: 8.0, w: 4.0, wall: 0 },
      { x: -52, z: 47, h: 8.6, w: 3.5, wall: 14 },
      { x: -59, z: 52, h: 9.0, w: 5.0, wall: 16 } ],
    // Switchback vista spur: juts off switchback B to a parapet overlooking the wreck field far
    // below — and the castle above. Ammo + a breather moment.
    [ { x: -108, z: -132, h: 32.0, w: 5.0, wall: 0 },
      { x: -92,  z: -120, h: 33.0, w: 4.0, wall: 4 },
      { x: -82,  z: -112, h: 33.5, w: 6.0, wall: 0 } ],
]

// Flat combat/POI pads stamped into the height field last. feather: how soft the pad edge is —
// the summit uses a HARD feather so its entrance lip is a real ledge, not a slope.
const FLATS = [
    { x: 150, z: 258, r: 15, h: 34.0, feather: 8 },    // start overlook
    { x: 96,  z: 182, r: 24, h: 6.0,  feather: 10 },   // basin arena
    { x: -6,  z: 92,  r: 25, h: 2.0,  feather: 10 },   // ruins arena
    { x: -76, z: 2,   r: 27, h: 6.0,  feather: 11 },   // wreck field arena
    { x: 34,  z: 95,  r: 7,  h: 11.0, feather: 4 },    // ruins overwatch ledge
    { x: -59, z: 52,  r: 5.5, h: 9.0, feather: 3 },    // canyon alcove
    { x: -82, z: -112, r: 7, h: 33.5, feather: 4 },    // switchback vista spur
    { x: -138, z: -226, r: 16, h: 50.0, feather: 7 },  // gate courtyard
    { x: CASTLE.arena.x, z: CASTLE.arena.z, r: CASTLE.arena.r, h: CASTLE.arena.floor, feather: 1.4 }, // summit bowl (hard lip)
]

// ---------------------------------------------------------------------------------------------
// Spawns. x/z only — Y is Terrain.HeightAt at spawn time (the old level's convention). Encounter
// density RAMPS toward the castle: 2 → 3 → 2 (ambush) → 2+beast → 1 overwatch → 3 (fortified) →
// the boss. Every group sits inside one arena's callout radius (24 m) but outside the next one's
// perception, so fights stay local and the journey keeps its rhythm.
// ---------------------------------------------------------------------------------------------
export const SPAWNS = {
    // NOTE the +PI: in this codebase the LOOK direction is opposite the spawn quaternion's yaw
    // (the camera rig decomposes the rotation and then faces down the negative axis — the old
    // depot's -PI/2 spawn relied on the same convention). Measured, not assumed.
    player: { x: 150, z: 259.5, yaw: Math.PI + Math.atan2(CASTLE.x - 150, CASTLE.z - 259.5) },
    soldiers: [
        // Basin — first contact, long sightlines, sparse cover.
        { x: 103, z: 176 }, { x: 88,  z: 191 },
        // Ruins — a held position among the arches; one on the flank.
        { x: -2,  z: 98 },  { x: 5,   z: 83 },  { x: -17, z: 97 },
        // Canyon exit — the ambush pair behind the barricades.
        { x: -52, z: 28 },  { x: -63, z: 17 },
        // Wreck field — dug in among the hulks (plus the beast below).
        { x: -73, z: -6 },  { x: -86, z: 5 },
        // Switchback overlook — one gunner holding the high parapet.
        { x: -111, z: -129 },
        // Gate courtyard — the last stand before the summit.
        { x: -132, z: -220 }, { x: -145, z: -229 }, { x: -138, z: -234 },
    ],
    // The prowling beast loose in the wreck field — the mid-journey spike.
    beasts: [ { x: -80, z: -12 } ],
    // THE BOSS: the beast that owns the summit arena. Placed off the entrance axis, behind the
    // fallen-keep rubble, so the player has to commit to the drop before the fight reads.
    boss: { x: -151, z: -272 },
    ammo: [
        { x: 91,  z: 176 },    // basin, by the wreck
        { x: 34,  z: 96 },     // ruins overwatch ledge
        { x: -58.5, z: 51 },   // canyon alcove
        { x: -81, z: 7 },      // wreck field
        { x: -82, z: -111 },   // switchback vista spur
        { x: -134, z: -229 },  // gate courtyard
    ],
}

// Smoke columns (damaged machinery) — consumed by Atmosphere. Kept at arena EDGES, off the
// walkable route, so smoke never sits between the player's crosshair and a target.
export const SMOKES = [
    { x: 84, z: 168, s: 0.8 },      // basin wreck
    { x: -88, z: 12, s: 1.0 },      // wreck field hulk
    { x: -66, z: -8, s: 0.7 },      // wreck field second column
    { x: -128, z: -214, s: 0.6 },   // gate brazier
]

// ---------------------------------------------------------------------------------------------
// Deterministic noise (JS mirror of DesertLook's GLSL value noise).
// ---------------------------------------------------------------------------------------------
function fract(v){ return v - Math.floor(v) }
function hash2(x, z){
    let px = fract(x * 0.3183099 + 0.71), pz = fract(z * 0.3183099 + 0.113)
    px *= 17.0; pz *= 17.0
    return fract(px * pz * (px + pz))
}
function vnoise(x, z){
    const ix = Math.floor(x), iz = Math.floor(z)
    let fx = x - ix, fz = z - iz
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz)
    const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
function fbm(x, z){
    let v = 0, a = 0.5, px = x, pz = z
    for(let i = 0; i < 4; i++){ v += a * vnoise(px, pz); px *= 2.02; pz *= 2.02; a *= 0.5 }
    return v
}
function smoothstep(a, b, t){
    const k = Math.min(1, Math.max(0, (t - a) / (b - a)))
    return k * k * (3 - 2 * k)
}
function lerp(a, b, t){ return a + (b - a) * t }

// ---------------------------------------------------------------------------------------------
// Spine sampling. All spines (main + branches) are densified once into ~2 m samples carrying
// interpolated h/w/wall; queries brute-force the nearest sample through a coarse spatial hash.
// ---------------------------------------------------------------------------------------------
function catmull(p0, p1, p2, p3, t){
    const t2 = t * t, t3 = t2 * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

function densify(points){
    const out = []
    for(let i = 0; i < points.length - 1; i++){
        const p0 = points[Math.max(0, i - 1)], p1 = points[i]
        const p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)]
        const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z)
        const steps = Math.max(2, Math.ceil(segLen / 2))
        for(let s = 0; s < steps; s++){
            const t = s / steps
            out.push({
                x: catmull(p0.x, p1.x, p2.x, p3.x, t),
                z: catmull(p0.z, p1.z, p2.z, p3.z, t),
                h: catmull(p0.h, p1.h, p2.h, p3.h, t),
                w: lerp(p1.w, p2.w, t),
                wall: lerp(p1.wall, p2.wall, t),
            })
        }
    }
    out.push({ ...points[points.length - 1] })
    return out
}

const SAMPLES = [ ...densify(SPINE) ]
for(const b of BRANCHES){ SAMPLES.push(...densify(b)) }

// Coarse hash grid over the samples (32 m cells): queries touch only nearby cells instead of the
// whole ~600-sample list, which matters because the terrain build runs ~66k queries.
const HASH_CELL = 32
const HASH = new Map()
SAMPLES.forEach((s, i) => {
    const cx = Math.floor(s.x / HASH_CELL), cz = Math.floor(s.z / HASH_CELL)
    for(let dz = -1; dz <= 1; dz++){
        for(let dx = -1; dx <= 1; dx++){
            const key = (cx + dx) * 4096 + (cz + dz)
            let arr = HASH.get(key)
            if(!arr){ arr = []; HASH.set(key, arr) }
            arr.push(i)
        }
    }
})

// Nearest spine sample to (x,z). Falls back to a full scan when the point is outside every hashed
// cell (far from any trail), which only happens out in the open dunes where accuracy is moot.
export function SpineQuery(x, z){
    const key = Math.floor(x / HASH_CELL) * 4096 + Math.floor(z / HASH_CELL)
    const idxs = HASH.get(key)
    let best = null, bestD2 = Infinity
    if(idxs){
        for(const i of idxs){
            const s = SAMPLES[i]
            const d2 = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z)
            if(d2 < bestD2){ bestD2 = d2; best = s }
        }
    }
    if(!best){
        // Far from every trail: report a distant miss with neutral params (env terrain wins).
        return { d: 999, h: 0, w: 6, wall: 8 }
    }
    return { d: Math.sqrt(bestD2), h: best.h, w: best.w, wall: best.wall }
}

// ---------------------------------------------------------------------------------------------
// The height function. Composed as: authored TRAIL blended into an ENVIRONMENT field (dunes +
// castle hill + start scarp + edge walls), then the arena FLATS stamped on top, then the rim fade.
// ---------------------------------------------------------------------------------------------
const VISTA_BRG = Math.atan2(CASTLE.x - 150, CASTLE.z - 258)   // overlook -> castle bearing

export function HeightOf(x, z){
    const q = SpineQuery(x, z)

    // --- Environment field ------------------------------------------------------------------
    // Two interfering dune trains + fbm, the same family of shapes FarWorld uses beyond the fence.
    const dA = Math.sin(x * 0.021 + Math.cos(z * 0.013) * 2.0) * Math.cos(z * 0.017 + 1.3)
    const dB = Math.sin((x * 0.6 + z * 0.8) * 0.041 + 1.7)
    let dunes = dA * 5.2 + dB * 2.6 + (fbm(x * 0.05, z * 0.05) - 0.5) * 6.0
    dunes = Math.max(dunes, -1.0)

    // Castle hill: a broad stepped mount. Shaped so the summit plateau covers the arena, the gate
    // shoulder sits near 50, the switchback face near 24–40, and the skirts die into the dunes.
    const rC = Math.hypot(x - CASTLE.x, z - CASTLE.z)
    const hillK = 1.0
        - 0.20 * smoothstep(28, 46, rC)
        - 0.45 * smoothstep(44, 120, rC)
        - 0.35 * smoothstep(110, 190, rC)
    const hill = 62 * Math.max(0, hillK)
    const hillT = smoothstep(190, 60, rC)          // 0 out in the dunes -> 1 on the mount

    // Start scarp: the overlook the player begins on. Dunes are calmed around it so no random
    // crest can stand on the plateau rim (one 5 m rim dune was enough to hide the entire castle).
    const rS = Math.hypot(x - 150, z - 258)
    const scarp = 35 * (1 - smoothstep(14, 64, rS))
    dunes *= 0.25 + 0.75 * smoothstep(18, 60, rS)

    // Edge walls: tall dunes ringing the playfield so the world ends in ridgelines, not a cliff of
    // nothing. Suppressed on the castle mount (the hill IS that corner's wall).
    const eDist = WORLD.half - Math.max(Math.abs(x), Math.abs(z))
    let edge = 16 * smoothstep(70, 22, eDist) * (1 + 0.5 * (fbm(x * 0.03 + 9, z * 0.03) - 0.5))
    edge *= (1 - hillT) * (1 - smoothstep(40, 12, rS))

    let env = dunes * (1 - hillT * 0.75) + hill + scarp + edge

    // The OPENING VISTA is load-bearing level design: a cone of terrain from the overlook toward
    // the castle is held under a descending ceiling, so the first frame of the game always shows
    // the full silhouette — golden light, dune sea, fortress — with nothing standing in the shot.
    // The trail's own descent runs inside this cone, so the carve reads as the valley the route
    // follows rather than as an artificial cut.
    const brg = Math.atan2(x - 150, z - 258)
    const dBrg = Math.abs(((brg - VISTA_BRG + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    const cone = smoothstep(0.42, 0.22, dBrg) * smoothstep(15, 28, rS) * (1 - smoothstep(120, 170, rS))
    if(cone > 0){
        const ceiling = 32.5 - (rS - 15) * 0.09
        env = lerp(env, Math.min(env, ceiling), cone)
    }

    // --- Trail + flanking bunds ---------------------------------------------------------------
    // The corridor: authored height with a slight upward dish toward the edges so it reads as a
    // worn trail. Beside it, the bund: a wind-piled barrier whose height is authored per waypoint.
    const pathH = q.h + 0.35 * Math.min(1, (q.d / Math.max(q.w, 0.001)) ** 2)
    const bund = q.wall
        * smoothstep(q.w + 2, q.w + 13, q.d) * (1 - smoothstep(q.w + 18, q.w + 46, q.d))
        * (0.75 + 0.5 * fbm(x * 0.08 + 3, z * 0.08))

    const k = smoothstep(q.w * 0.6, q.w + 16, q.d)
    let h = lerp(pathH, env + bund, k)

    // --- Arena flats ----------------------------------------------------------------------------
    for(const f of FLATS){
        const d = Math.hypot(x - f.x, z - f.z)
        const kf = 1 - smoothstep(f.r - f.feather, f.r, d)
        if(kf > 0){ h = lerp(h, f.h + (fbm(x * 0.13, z * 0.13) - 0.5) * 0.25, kf) }
    }

    // --- Fine grain + rim fade ------------------------------------------------------------------
    // Kept LOW-frequency relative to the 2.5 m heightfield cells: anything busier than ~half the
    // cell frequency aliases into per-vertex jitter, which the grazing key light turns into a
    // checkerboard of facet normals. Sub-metre sand detail belongs to the shader ripples instead.
    h += (fbm(x * 0.16 + 40, z * 0.16) - 0.5) * 0.18
    if(eDist < 14){ h = lerp(WORLD.rim, h, smoothstep(0, 14, eDist)) }
    return h
}

// Build the raw heightfield Terrain consumes (opts.heights): absolute world heights, row-major,
// gridN x gridN over the WORLD footprint.
export function BuildHeights(){
    const N = WORLD.gridN
    const heights = new Float32Array(N * N)
    const min = -WORLD.half, size = WORLD.size
    for(let j = 0; j < N; j++){
        const z = min + (j / (N - 1)) * size
        for(let i = 0; i < N; i++){
            const x = min + (i / (N - 1)) * size
            heights[j * N + i] = HeightOf(x, z)
        }
    }
    return heights
}

// Terrain constructor options for the journey world (see Terrain.js — heights bypasses the image).
export function BuildTerrainOpts(){
    return {
        centerX: 0, centerZ: 0,
        sizeX: WORLD.size, sizeZ: WORLD.size,
        segX: WORLD.seg, segZ: WORLD.seg,
        gridN: WORLD.gridN,
        heights: BuildHeights(),
    }
}

// ---------------------------------------------------------------------------------------------
// Walkability mask for the navmesh generator: on the trail, in an arena flat, or on a branch.
// (Structure footprints and slope limits are applied by the generator itself.)
// ---------------------------------------------------------------------------------------------
export function IsOnRoute(x, z){
    const q = SpineQuery(x, z)
    if(q.d < q.w - 0.4){ return true }
    for(const f of FLATS){
        if(Math.hypot(x - f.x, z - f.z) < f.r - 0.8){ return true }
    }
    return false
}

export { FLATS, SPINE }
