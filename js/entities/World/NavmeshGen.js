import * as THREE from 'three'
import { WORLD, IsOnRoute, CASTLE, SPAWNS } from './JourneyWorld.js'

// Procedural navmesh for the journey level, replacing the baked navmesh.obj the old depot shipped.
//
// The walkable surface is derived from the SAME authored data the terrain is built from — the
// trail spine, the arena flats and the side branches (JourneyWorld.IsOnRoute) — minus:
//
//   * SLOPE: cells steeper than ~38° are cut. This is also what severs the summit arena from the
//     final ascent at the drop-in lip, so the boss's navmesh island is created by the level's own
//     geometry rather than by any special-case AI code;
//   * STRUCTURES: every collider footprint (Structures.footprints) is cut with 1.0 m of clearance,
//     matching the beast's SmoothPath agent radius, so no path ever routes through or hugs a wall.
//
// Output is a plain grid-triangulated THREE.Mesh hugging the terrain (verts at HeightAt + 0.12 —
// the same "just above the floor" convention the old baked mesh used, which the controllers'
// vertical containment window depends on). Only the components containing the player's route and
// the boss arena are kept; stray slivers are dropped so getGroup can never resolve to a fragment.
//
// The mesh is handed to the existing Navmesh component untouched — three-pathfinding zones,
// groups, funnel string-pulling, SmoothPath clearance and clampStep all keep working as before.

const CELL = 2.75          // metres per nav cell — fine enough for the 9 m canyon, coarse enough
                           // that A* over the whole level stays cheap for the beast's 8 Hz repath
// Slope walkability. Raised HIGH (from 0.8 ≈ 38.6°) so enemies can climb essentially ANY natural
// slope the route crosses — dune faces, switchbacks, and the deliberately steep ~50° gate ramp the
// player takes — instead of stalling at the base of anything over ~39°. 3.0 ≈ 71.6°, so only
// near-vertical cliffs stay unwalkable; and since the navmesh is gated to IsOnRoute, this only ever
// opens up on-route slopes, never canyon walls. The boss arena is no longer severed by this slope
// cut (the ~50° ramp and the drop-in lip are similar steepness, so any limit that passes the ramp
// passes the lip too) — it is severed instead by the rim-moat band below, widened to guarantee it.
const SLOPE_LIMIT = 3.0    // rise/run (~71.6°) — above this a cell is unwalkable (near-vertical only)
const CLEARANCE = 1.0      // structure-footprint inflation (m) — the beast's path clearance

export function BuildJourneyNavmesh(terrain, footprints){
    const half = WORLD.half
    const nx = Math.floor((half * 2) / CELL)
    const nz = Math.floor((half * 2) / CELL)
    const x0 = -half, z0 = -half

    // --- 1. Classify cells --------------------------------------------------------------------
    const walk = new Uint8Array(nx * nz)
    const cellX = (i) => x0 + (i + 0.5) * CELL
    const cellZ = (j) => z0 + (j + 0.5) * CELL

    const inFootprint = (x, z) => {
        for(const f of footprints){
            const dx = x - f.x, dz = z - f.z
            // into the footprint's yaw frame
            const lx = dx * f.cos - dz * f.sin
            const lz = dx * f.sin + dz * f.cos
            if(Math.abs(lx) < f.hx + CLEARANCE && Math.abs(lz) < f.hz + CLEARANCE){ return true }
        }
        return false
    }

    // Slope probes are ONE-SIDED at ±1.2 m. A central difference across a whole cell (±2.75 m)
    // halves any cliff narrower than the window — which is exactly what the boss arena's 1.4 m
    // drop-in ledge is — so the ledge read as walkable while honest mid-ramp slopes were cut.
    // Short one-sided probes measure the worst local step instead. 1.2 m is shorter than the
    // trail-to-bund standoff (2 m), so canyon floors don't get eaten by the walls beside them.
    const PROBE = 1.2
    const tooSteep = (x, z, h0) => {
        if(Math.abs(terrain.HeightAt(x + PROBE, z) - h0) / PROBE > SLOPE_LIMIT){ return true }
        if(Math.abs(terrain.HeightAt(x - PROBE, z) - h0) / PROBE > SLOPE_LIMIT){ return true }
        if(Math.abs(terrain.HeightAt(x, z + PROBE) - h0) / PROBE > SLOPE_LIMIT){ return true }
        if(Math.abs(terrain.HeightAt(x, z - PROBE) - h0) / PROBE > SLOPE_LIMIT){ return true }
        return false
    }

    // The boss arena's rim moat: an explicit exclusion band along the summit bowl's edge, so the
    // island is severed BY CONSTRUCTION whatever the slope sampling says. The bowl interior and
    // the ramp outside both survive; only the ledge line itself is cut. (The victory stair crosses
    // this band as structure geometry, which was never navmesh — AI stays confined either way.)
    // The band is now the SOLE severing mechanism (the raised SLOPE_LIMIT no longer cuts the lip), so
    // it must be at least one CELL (2.75 m) wide or a radial could bridge it with two adjacent cells
    // whose centres straddle the gap. Widened to 3.0 m (A.r-1.4 .. A.r+1.6) to guarantee a complete
    // cut on every radial; the arena floor (r 19) only loses a 0.6 m rim, still a 17.6 m walkable bowl.
    const A = CASTLE.arena

    for(let j = 0; j < nz; j++){
        for(let i = 0; i < nx; i++){
            const x = cellX(i), z = cellZ(j)
            if(!IsOnRoute(x, z)){ continue }
            const dA = Math.hypot(x - A.x, z - A.z)
            if(dA > A.r - 1.4 && dA < A.r + 1.6){ continue }
            const h0 = terrain.HeightAt(x, z)
            if(tooSteep(x, z, h0)){ continue }
            if(inFootprint(x, z)){ continue }
            walk[j * nx + i] = 1
        }
    }

    // --- 2. Connected components; keep the route component + the boss island -------------------
    const comp = new Int32Array(nx * nz).fill(-1)
    let nComp = 0
    const stack = []
    for(let j = 0; j < nz; j++){
        for(let i = 0; i < nx; i++){
            const idx = j * nx + i
            if(!walk[idx] || comp[idx] !== -1){ continue }
            stack.length = 0
            stack.push(idx)
            comp[idx] = nComp
            while(stack.length){
                const c = stack.pop()
                const ci = c % nx, cj = (c / nx) | 0
                const neigh = [
                    ci > 0 ? c - 1 : -1, ci < nx - 1 ? c + 1 : -1,
                    cj > 0 ? c - nx : -1, cj < nz - 1 ? c + nx : -1,
                ]
                for(const n of neigh){
                    if(n >= 0 && walk[n] && comp[n] === -1){ comp[n] = nComp; stack.push(n) }
                }
            }
            nComp++
        }
    }

    const compAt = (x, z) => {
        const i = Math.floor((x - x0) / CELL), j = Math.floor((z - z0) / CELL)
        if(i < 0 || i >= nx || j < 0 || j >= nz){ return -1 }
        return comp[j * nx + i]
    }
    // Resolve a component by sampling near a point (the exact cell may have been cut by a
    // footprint; spiral out a few cells).
    const compNear = (x, z) => {
        for(let r = 0; r < 4; r++){
            for(let dj = -r; dj <= r; dj++){
                for(let di = -r; di <= r; di++){
                    const c = compAt(x + di * CELL, z + dj * CELL)
                    if(c >= 0){ return c }
                }
            }
        }
        return -1
    }

    const mainComp = compNear(SPAWNS.player.x, SPAWNS.player.z)
    const bossComp = compNear(SPAWNS.boss.x, SPAWNS.boss.z)
    const keep = new Set()
    if(mainComp >= 0){ keep.add(mainComp) }
    if(bossComp >= 0){ keep.add(bossComp) }
    if(mainComp >= 0 && bossComp >= 0 && mainComp === bossComp){
        console.warn('[NavmeshGen] boss arena is CONNECTED to the route — the drop-in lip did not sever it')
    }

    // --- 3. Triangulate the kept cells ----------------------------------------------------------
    const vertIndex = new Map()      // (i,j) grid corner -> vertex index
    const positions = []
    const indices = []
    const cornerY = new Map()

    const vertexAt = (i, j) => {
        const key = j * (nx + 1) + i
        let vi = vertIndex.get(key)
        if(vi !== undefined){ return vi }
        const x = x0 + i * CELL, z = z0 + j * CELL
        let y = cornerY.get(key)
        if(y === undefined){ y = terrain.HeightAt(x, z) + 0.12; cornerY.set(key, y) }
        vi = positions.length / 3
        positions.push(x, y, z)
        vertIndex.set(key, vi)
        return vi
    }

    let cells = 0
    for(let j = 0; j < nz; j++){
        for(let i = 0; i < nx; i++){
            const idx = j * nx + i
            if(!walk[idx] || !keep.has(comp[idx])){ continue }
            const a = vertexAt(i, j), b = vertexAt(i + 1, j)
            const c = vertexAt(i, j + 1), d = vertexAt(i + 1, j + 1)
            indices.push(a, c, b, b, c, d)      // CCW from above, matching the terrain winding
            cells++
        }
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geom.setIndex(indices)
    geom.computeVertexNormals()

    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.35,
    }))
    mesh.name = 'JourneyNavmesh'
    mesh.visible = false             // debug aid: scene never shows it, but it can be toggled
    mesh.userData.noExport = true

    console.log(`[NavmeshGen] ${cells} cells, ${positions.length / 3} verts, ` +
        `${nComp} raw components (kept ${keep.size}: route + boss island)`)
    return mesh
}

// Convenience for entry.js: the boss island exists iff these resolve to different groups after
// zone build — logged there for the validation pass.
export const NAV_PROBES = {
    route: { x: SPAWNS.player.x, z: SPAWNS.player.z },
    boss: { x: CASTLE.arena.x, z: CASTLE.arena.z },
}
