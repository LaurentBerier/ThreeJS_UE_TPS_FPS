import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, windDirection, windStrengthAt } from './DesertLook.js'


// Cloth in the world wind: banner flags streaming off poles along the journey.
//
// The solver (ClothSim) is deliberately GENERIC — a pinned verlet grid driven by the shared wind
// from DesertLook — because the flags are only its first customer: a player CAPE is the planned
// second, and that is just the same grid with its top row pinned to two shoulder-bone sockets
// instead of a pole edge (call setPin() per frame with the bone world positions; everything else
// — wind, gravity, constraints, the streaming look — is already this file).
//
// Safety contract, same spirit as FarWorld's: no physics bodies, no navmesh impact, no UE export
// (userData.noExport), and flags fly ABOVE head height so cloth never crosses a crosshair at
// combat range.

// ---------------------------------------------------------------------------------------------
// Verlet cloth grid. cols × rows nodes, spacing metres apart. Pins are node indices held to
// explicit world positions (static for a flag pole; per-frame for a future cape).
// ---------------------------------------------------------------------------------------------
export class ClothSim{
    // opts.bend: also link every SECOND neighbour (c→c+2, r→r+2 at rest 2·spacing). Bend links
    // are what give a cloth FLEXURAL stiffness: structural+shear alone allow the grid to fold to
    // a zero-volume crumple for free, which is fine for a slack banner but reads as "wet paper"
    // on a cape. The flags pass nothing and simulate exactly as before.
    constructor(cols, rows, spacing, origin, initDir, opts = null){
        this.cols = cols; this.rows = rows; this.spacing = spacing
        const n = cols * rows
        this.pos = new Float64Array(n * 3)
        this.prev = new Float64Array(n * 3)
        this.pins = new Map()            // node index -> THREE.Vector3 (held position)
        // Lay the grid out streaming along initDir so the first frames don't thrash.
        for(let r = 0; r < rows; r++){
            for(let c = 0; c < cols; c++){
                const i = (r * cols + c) * 3
                this.pos[i]     = origin.x + initDir.x * c * spacing
                this.pos[i + 1] = origin.y - r * spacing
                this.pos[i + 2] = origin.z + initDir.z * c * spacing
                this.prev[i] = this.pos[i]; this.prev[i + 1] = this.pos[i + 1]; this.prev[i + 2] = this.pos[i + 2]
            }
        }
        // Constraint list: structural (right + down neighbours) and shear (both diagonals).
        // Shear is what stops the grid collapsing into a swinging chain of rows.
        this.links = []
        const idx = (c, r) => r * cols + c
        const d = spacing
        // Optional per-row HORIZONTAL rest scale (opts.colScale, length rows). A cape narrows its
        // collar to a gathered yoke; scaling the horizontal rest length — and the horizontal share
        // of the diagonal and bend rests — to match lets the narrowed rows sit at REST instead of
        // fighting the pin (the "trapezoidal rest shape so the links agree" a narrow clasp needs).
        // Flags pass nothing, so every scale is 1 and the grid is byte-identical to before.
        const cs = (opts && opts.colScale) || null
        for(let r = 0; r < rows; r++){
            const sr = cs ? cs[r] : 1
            for(let c = 0; c < cols; c++){
                if(c + 1 < cols){ this.links.push([idx(c, r), idx(c + 1, r), d * sr]) }
                if(r + 1 < rows){ this.links.push([idx(c, r), idx(c, r + 1), d]) }
                if(c + 1 < cols && r + 1 < rows){
                    const sd = cs ? (cs[r] + cs[r + 1]) * 0.5 : 1
                    const diag = Math.hypot(d * sd, d)
                    this.links.push([idx(c, r), idx(c + 1, r + 1), diag])
                    this.links.push([idx(c + 1, r), idx(c, r + 1), diag])
                }
                if(opts && opts.bend){
                    if(c + 2 < cols){ this.links.push([idx(c, r), idx(c + 2, r), d * 2 * sr]) }
                    if(r + 2 < rows){ this.links.push([idx(c, r), idx(c, r + 2), d * 2]) }
                }
            }
        }
    }

    setPin(node, worldPos){ this.pins.set(node, worldPos.clone ? worldPos.clone() : worldPos) }

    // dt: seconds (caller clamps). time: the world clock, for gusts. phase: per-cloth offset so a
    // row of flags doesn't flap in lockstep.
    //
    // opts (all optional — flags pass nothing and behave exactly as before):
    //   windVec  THREE.Vector3, the TOTAL wind in m/s including magnitude. This is how the cape
    //            feeds APPARENT wind (world wind minus the wearer's velocity) — a sprint reads as
    //            a headwind streaming the cloth back even on a calm beat.
    //   aero     air-grip multiplier on that vector (default 1.5 on the built-in gust path).
    //   gravity  fraction of full weight (default 0.3 — banner fabric; a cape wants more hang).
    //   rounds   constraint relaxation iterations (default 2; the cape runs more — it is pinned
    //            by moving anchors and shows stretch more than a pole flag does).
    //   damp     velocity retention per step (default 0.985). Lower = heavier, calmer fabric.
    //   nodeWind per-node wind multiplier (Float64Array, cols*rows). How the cape models the
    //            torso's WIND SHADOW: cloth hanging against the body's back sees almost no
    //            clean air, the free tail sticks out into the full stream.
    //   nodeDamp per-node multiplier on damp (same layout) — lets a region swing less without
    //            deadening the whole sheet.
    step(dt, time, phase = 0, opts = null){
        let wx, wy, wz, gustMag
        if(opts && opts.windVec){
            const aero = opts.aero != null ? opts.aero : 1.0
            wx = opts.windVec.x * aero; wy = opts.windVec.y * aero; wz = opts.windVec.z * aero
            gustMag = Math.hypot(wx, wy, wz)
        }else{
            const wind = windDirection()
            // 1.5 aero factor: at the base wind the first pass hung gravity-dominated (the vista
            // flag read as a dead banner between gusts); real flag fabric catches far more air
            // than its weight suggests, and this is the knob that decides stream-vs-droop.
            gustMag = windStrengthAt(time + phase) * 1.5
            wx = windDirection().x * gustMag; wy = 0; wz = windDirection().z * gustMag
        }
        const damp = opts && opts.damp != null ? opts.damp : 0.985
        const nodeWind = (opts && opts.nodeWind) || null
        const nodeDamp = (opts && opts.nodeDamp) || null
        const gFrac = opts && opts.gravity != null ? opts.gravity : 0.3
        const g = -9.8 * gFrac * dt * dt         // light fabric: gravity softened vs full weight
        const n = this.cols * this.rows
        for(let i = 0; i < n; i++){
            const o = i * 3
            const px = this.pos[o], py = this.pos[o + 1], pz = this.pos[o + 2]
            // Per-node turbulence rides the gust so the cloth ripples rather than tilting rigidly.
            const flutter = Math.sin(time * 7.3 + i * 1.7 + phase) * 0.35
                          + Math.sin(time * 11.7 + i * 0.53 + phase * 2.0) * 0.2
            const ws = nodeWind ? nodeWind[i] : 1
            const di = nodeDamp ? damp * nodeDamp[i] : damp
            const w = (0.8 + flutter * 0.4) * dt * dt * ws
            const vx = (px - this.prev[o]) * di
            const vy = (py - this.prev[o + 1]) * di
            const vz = (pz - this.prev[o + 2]) * di
            this.prev[o] = px; this.prev[o + 1] = py; this.prev[o + 2] = pz
            this.pos[o]     = px + vx + wx * w
            this.pos[o + 1] = py + vy + g + wy * w + Math.abs(flutter) * gustMag * w * 0.5   // gusts also LIFT
            this.pos[o + 2] = pz + vz + wz * w
        }
        // Constraint relaxation. Two rounds is visibly enough at flag scale; capes want three.
        const rounds = opts && opts.rounds ? opts.rounds : 2
        for(let it = 0; it < rounds; it++){
            for(const [a, b, rest] of this.links){
                const ao = a * 3, bo = b * 3
                let dx = this.pos[bo] - this.pos[ao]
                let dy = this.pos[bo + 1] - this.pos[ao + 1]
                let dz = this.pos[bo + 2] - this.pos[ao + 2]
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6
                const k = (len - rest) / len * 0.5
                dx *= k; dy *= k; dz *= k
                this.pos[ao] += dx; this.pos[ao + 1] += dy; this.pos[ao + 2] += dz
                this.pos[bo] -= dx; this.pos[bo + 1] -= dy; this.pos[bo + 2] -= dz
            }
            for(const [node, p] of this.pins){
                const o = node * 3
                this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Banner flags on poles. Positions are x/z + pole height; ground Y comes from Terrain.HeightAt
// at Initialize, the same contract every spawn uses.
// ---------------------------------------------------------------------------------------------
const FLAGS = [
    // (The start-overlook flag was removed — a WorldProps dead tree stands there now.)
    // Gate courtyard — the last-stand arena reads as HELD ground; a banner says whose.
    { x: -131.5, z: -220.5, pole: 5.6 },
    // Switchback vista spur parapet — visible from the wreck field far below.
    { x: -84, z: -114.5, pole: 5.0 },
]
const COLS = 9, ROWS = 6, SPACING = 0.24     // ≈1.9 m × 1.2 m of cloth

export default class WindFlags extends Component{
    constructor(scene){
        super()
        this.name = 'WindFlags'
        this.scene = scene
        this.time = 0
        this.flags = []
        this.root = new THREE.Group()
        this.root.name = 'WindFlags'
        this.root.userData.noExport = true
    }

    Initialize(){
        const terrain = this.GetComponent('Terrain')
        const windD = windDirection()
        const poleMat = new THREE.MeshStandardMaterial({ color: PALETTE.steelBlack, roughness: 0.7, metalness: 0.25 })
        // Deep rust-red banner: reads against BOTH the bright sand and the golden sky, and it is
        // the faction colour the bronze/rust container family already established.
        const clothMat = new THREE.MeshStandardMaterial({
            color: 0x7c2a18, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide,
        })

        for(let f = 0; f < FLAGS.length; f++){
            const spec = FLAGS[f]
            const gy = terrain ? terrain.HeightAt(spec.x, spec.z) : 0
            // Pole.
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, spec.pole, 7), poleMat)
            pole.position.set(spec.x, gy + spec.pole / 2, spec.z)
            pole.castShadow = true
            pole.userData.noExport = true
            this.root.add(pole)

            // Cloth, top edge starting just under the pole cap, pinned down the pole.
            const top = new THREE.Vector3(spec.x, gy + spec.pole - 0.12, spec.z)
            const sim = new ClothSim(COLS, ROWS, SPACING, top, windD)
            for(let r = 0; r < ROWS; r++){
                const p = new THREE.Vector3(spec.x, top.y - r * SPACING, spec.z)
                sim.setPin(r * COLS, p)
            }

            const geo = new THREE.BufferGeometry()
            const verts = new Float32Array(COLS * ROWS * 3)
            geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
            const idx = []
            for(let r = 0; r < ROWS - 1; r++){
                for(let c = 0; c < COLS - 1; c++){
                    const a = r * COLS + c, b = a + 1, d = a + COLS, e = d + 1
                    idx.push(a, d, b, b, d, e)
                }
            }
            geo.setIndex(idx)
            const mesh = new THREE.Mesh(geo, clothMat)
            mesh.frustumCulled = false        // tiny geometry; its bounds move every frame
            mesh.castShadow = true
            mesh.userData.noExport = true
            this.root.add(mesh)

            this.flags.push({ sim, geo, phase: f * 2.39 })
        }
        this.scene.add(this.root)
    }

    Update(t){
        this.time += t
        // Two substeps of a clamped dt keep the cloth stable through frame hitches without ever
        // letting a spike stretch it (verlet + big dt = trampoline).
        const dt = Math.min(t, 1 / 30) / 2
        for(const f of this.flags){
            f.sim.step(dt, this.time, f.phase)
            f.sim.step(dt, this.time + dt, f.phase)
            const p = f.geo.attributes.position
            const src = f.sim.pos
            for(let i = 0; i < p.count * 3; i++){ p.array[i] = src[i] }
            p.needsUpdate = true
            f.geo.computeVertexNormals()
        }
    }

    Dispose(){
        for(const f of this.flags){ f.geo.dispose() }
        this.scene.remove(this.root)
    }
}
