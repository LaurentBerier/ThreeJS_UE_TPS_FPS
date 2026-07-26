import * as THREE from 'three'
import Component from '../../Component.js'
import { CASTLE } from './JourneyWorld.js'

// The ART PASS. Replaces the procedural greybox landmarks (Structures.js) and dresses the journey
// with the 20 sculpted Meshy models — obelisks, arches, walls, wrecks, machinery, bones, dead
// trees, crystals, mesas and marker posts — compressed to shipping GLBs (assets/World/props/,
// ~0.6–2 MB each; see tools/compress_props.mjs).
//
// CONTRACTS (what keeps this from breaking the game):
//
//   * PURELY VISUAL. This component adds meshes and NOTHING else — no colliders, no physics
//     bodies, no navmesh footprints, no spawns. Collision, line-of-sight, the camera boom and the
//     navmesh are still owned entirely by Structures.js + Terrain, unchanged. Where a prop stands
//     in for a greybox piece, that piece is flagged `visual:false` in Structures (collider kept,
//     box mesh dropped) so the collider survives and there is no double geometry.
//
//   * OFF-ROUTE SCATTER carries no collider by design: dead trees, bones, crystals and mesas are
//     placed off the walkable trail/arenas, where the navmesh never reaches, so nothing needs a
//     hull. Anything a player can walk into sits on a Structures collider.
//
//   * FOG + PALETTE come for free. The materials are left STOCK (their own baked Meshy PBR), so
//     DesertLook's global fog ShaderChunk override + the stock onBeforeCompile fog-uniform hook
//     apply automatically (see DesertLook.js — "GLB props" is an explicit target of that hook).
//     A light optional grade knits their albedo into the dark-red palette (GRADE below).
//
//   * Each prop model is normalised by Meshy to a ~1.9-unit box centred on the origin, Y-up — the
//     same axis convention as three, so no axis swap is ever needed. Placement is authored in
//     WORLD METRES along a chosen axis; the component measures each model's real bounds at load and
//     derives the scale + the ground-seating offset, so the base always rests on the terrain.
//
// Built as a Level component after Structures. Deterministic: fixed placement table, no randomness.
export default class WorldProps extends Component{
    constructor(scene, terrain, propScenes){
        super()
        this.name = 'WorldProps'
        this.scene = scene
        this.terrain = terrain
        this.templates = {}         // name -> { object, box, size, center }

        this.root = new THREE.Group()
        this.root.name = 'WorldProps'

        this._prepareTemplates(propScenes)
        this._build()
        this.scene.add(this.root)
    }

    // Measure each loaded model once and set up its shared material/shadow flags. Clones made later
    // share this geometry + material set (three's Object3D.clone keeps those by reference), so N
    // placements of a prop cost one geometry and one texture set in memory.
    _prepareTemplates(propScenes){
        for(const [name, scene] of Object.entries(propScenes)){
            if(!scene){ continue }
            scene.traverse((n) => {
                if(n.isMesh){
                    n.castShadow = true
                    n.receiveShadow = true
                    // Meshy bakes a full-white emissiveFactor over a black map; the compressor drops
                    // the map, but zero the factor too so no material can self-illuminate (the world's
                    // only emissive is the cyan tech accent).
                    const mats = Array.isArray(n.material) ? n.material : [n.material]
                    for(const m of mats){
                        if(!m){ continue }
                        if(m.emissive){ m.emissive.setRGB(0, 0, 0) }
                        m.fog = true
                        this._grade(m)
                    }
                }
            })
            scene.updateMatrixWorld(true)     // Meshy wraps meshes in transformed nodes — bake them before measuring
            const box = new THREE.Box3().setFromObject(scene)
            const size = new THREE.Vector3(); box.getSize(size)
            const center = new THREE.Vector3(); box.getCenter(center)
            this.templates[name] = { object: scene, box, size, center }
        }
    }

    // Light palette knit: the world is graded dark (structure albedo luminance ~0.16 so the sand
    // stays the brightest surface — a combat-readability rule). Meshy's raw albedo reads a little
    // bright/clean against that, so pull it down and toward the desert tone WITHOUT touching the
    // texture detail. Applied on outgoing light would need a custom shader (which would drop the
    // stock fog hook); a factor tweak on color/roughness is enough here and keeps the fog for free.
    _grade(mat){
        if(mat.userData.dlProp){ return }
        mat.userData.dlProp = true
        if(mat.color){ mat.color.multiplyScalar(0.82) }          // settle into the charcoal world
        if(typeof mat.roughness === 'number'){ mat.roughness = Math.min(1, mat.roughness * 1.05 + 0.04) }
    }

    // groundY under a point.
    _g(x, z){ return this.terrain.HeightAt(x, z) }

    // Place one prop. opts:
    //   size  target extent in metres along `axis`
    //   axis  'y' (height) | 'x' | 'z' | 'max' (longest) — which model dimension `size` sets
    //   yaw   rotation about up (radians)
    //   sink  metres to bury the base below the terrain (settle a piece into the sand)
    //   tilt  [rx, rz] extra lean for fallen pieces (approximate seating; pair with sink)
    //   ground  explicit ground datum override (e.g. an arena floor)
    _put(name, x, z, opts = {}){
        const t = this.templates[name]
        if(!t){ console.warn('[WorldProps] missing prop', name); return null }
        const axis = opts.axis || 'max'
        const dim = axis === 'max' ? Math.max(t.size.x, t.size.y, t.size.z) : t.size[axis]
        const k = (opts.size || 2) / (dim || 1)

        const g = new THREE.Group()
        const inst = t.object.clone(true)
        // Re-centre the model on the group origin so scale + yaw pivot on its centre; the base is
        // seated via Y below. (Meshy centres at ~0 already, but this stays exact if it doesn't.)
        inst.position.set(-t.center.x, -t.center.y, -t.center.z)
        g.add(inst)
        g.scale.setScalar(k)
        g.rotation.order = 'YXZ'
        g.rotation.y = opts.yaw || 0
        if(opts.tilt){ g.rotation.x = opts.tilt[0] || 0; g.rotation.z = opts.tilt[1] || 0 }

        const groundY = opts.ground != null ? opts.ground : this._g(x, z)
        // world base = groundY - sink; base is (center.y - box.min.y) = size.y/2 below centre.
        g.position.set(x, groundY + (t.size.y * 0.5) * k - (opts.sink || 0), z)
        g.matrixAutoUpdate = false
        g.updateMatrix()
        g.userData.propName = name
        this.root.add(g)
        return g
    }

    // A short line of the same prop (wall runs, pipe runs, marker rows). Steps along `yaw`.
    _row(name, x, z, yaw, n, step, opts = {}){
        const dx = Math.sin(yaw + Math.PI / 2), dz = Math.cos(yaw + Math.PI / 2)
        for(let i = 0; i < n; i++){
            this._put(name, x + dx * i * step, z + dz * i * step,
                { ...opts, yaw: yaw + (opts.jitter ? (i % 2 ? 0.14 : -0.1) : 0) })
        }
    }

    // ==============================================================================================
    // THE PLACEMENTS. Coordinates mirror JourneyWorld / Structures landmarks. Pieces marked
    // "(replaces …)" have their greybox twin flagged visual:false in Structures.js.
    // ==============================================================================================
    _build(){
        this._startArea()
        this._basin()
        this._saddle()
        this._ruins()
        this._canyon()
        this._wreckField()
        this._switchbacks()
        this._gate()
        this._summit()
        this._scatter()
    }

    // 1. Start overlook — the opening frame. Keep the vista cone toward the castle CLEAR: only
    // low/side dressing here, nothing tall on the sightline.
    _startArea(){
        const yaw = Math.atan2(CASTLE.x - 150, CASTLE.z - 258)
        // Two obelisks framing the castle bearing (replace the greybox piers). Pushed a touch wider
        // than the old piers so the opening castle silhouette stays clear between them.
        const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }
        for(const s of [-1, 1]){
            this._put('01_Obelisk', 145 + right.x * 6.2 * s, 252 + right.z * 6.2 * s, { size: 7.6, axis: 'y', yaw })
        }
        // The lintel still spanning the two piers (replaces the start lintel box).
        this._put('02_Archway_Lintel', 145, 252, { size: 12, axis: 'x', yaw, ground: this._g(145, 252) + 7.4 })
        // A marker post at the trailhead, off to the side of the shot.
        this._put('19_Marker_Post', 156, 250, { size: 4.2, axis: 'y', yaw: 0.4 })
        // A downed marker mast where the old antenna lay.
        this._put('19_Marker_Post', 160, 267, { size: 4.6, axis: 'y', tilt: [0, 1.2], sink: 0.3 })
    }

    // 2. Basin arena — first contact. The dead hulk + a pipe wall as the long cover line.
    _basin(){
        // Wreck hulk over the basin wreck (replaces _wreckHulk 84,168).
        this._put('18_Wreckage', 84, 168, { size: 10, axis: 'z', yaw: 0.9, sink: 0.2 })
        // West-rim pipe wall run (replaces the basin _wallRun 82,194).
        this._row('04_Wall_Broken_Pipes', 82, 194, -0.6, 4, 3.1, { size: 4.2, axis: 'x', jitter: true, sink: 0.15 })
        // Cover barriers (replace the three basin cover boxes).
        this._put('05_Barrier_Wall', 100, 186, { size: 3.0, axis: 'x', yaw: 0.4 })
        this._put('05_Barrier_Wall', 92, 176, { size: 2.6, axis: 'x', yaw: -0.7 })
        this._put('20_Tech_Crate', 104, 174, { size: 1.7, axis: 'x', yaw: 1.2 })
        // Ammo cache crate (by the basin ammo at 91,176).
        this._put('20_Tech_Crate', 90.4, 176.6, { size: 1.5, axis: 'x', yaw: 0.3 })
    }

    // 3. Saddle — the vista beat: a monolith pair gates the crest (replaces the two saddle boxes).
    _saddle(){
        this._put('01_Obelisk', 38, 144, { size: 8.2, axis: 'y', yaw: 0.2, tilt: [0, 0.06] })
        this._put('01_Obelisk', 29, 137, { size: 7.2, axis: 'y', yaw: -0.3, tilt: [0, -0.05] })
    }

    // 4. Ruins arena — buried civilisation. The grand arch, wall runs, half-buried machinery + the
    // first ancient-tech accent.
    _ruins(){
        // Red-rock arch centrepiece (replaces _brokenArch -14,86).
        this._put('09_Red_Rock_Arch', -14, 86, { size: 12, axis: 'x', yaw: 0.7 })
        // Two wall runs of broken pipe-wall (replace the ruins _wallRun pair).
        this._row('04_Wall_Broken_Pipes', -2, 100, 0.35, 4, 3.1, { size: 4.4, axis: 'x', jitter: true, sink: 0.15 })
        this._row('04_Wall_Broken_Pipes', 4, 80, -1.2, 3, 3.1, { size: 4.0, axis: 'x', jitter: true, sink: 0.2 })
        // Broken ancient pillars the soldiers strafe between (replace the greybox cylinder pillars).
        this._put('19_Marker_Post', -10, 96, { size: 3.4, axis: 'y', yaw: 0.3 })
        this._put('19_Marker_Post', 2, 92, { size: 2.7, axis: 'y', yaw: 2.0 })
        this._put('19_Marker_Post', -4, 78, { size: 3.7, axis: 'y', yaw: -1.1 })
        // Half-buried machinery (replaces the ruins machinery box -18,82).
        this._put('16_Broken_Mechanism', -18, 82, { size: 4.2, axis: 'x', yaw: 2.1, sink: 0.25 })
        // The ancient-tech thread starts: a portal pad among the ruins + a crystal beside it.
        this._put('06_Portal_Pad', -22, 90, { size: 6.5, axis: 'max', yaw: 0.5, sink: 0.05 })
        this._put('15_Crystal_Cluster', -24.5, 88, { size: 3.0, axis: 'y', yaw: 1.3 })
        // Overwatch ledge platform (the ruins branch flat at 34,95).
        this._put('07_Platform_Octagon', 34, 95, { size: 7.5, axis: 'max', yaw: 0.75, ground: 11.0 - 0.2 })
    }

    // 5. Canyon — the squeeze. Pipes hug the wall; a vent pod; the alcove crystal cache.
    _canyon(){
        this._row('04_Wall_Broken_Pipes', -46.5, 45, 0.72, 3, 3.4, { size: 5.0, axis: 'x', sink: 0.2 })
        this._put('17_Tech_Pod', -51, 49, { size: 3.0, axis: 'max', yaw: 0.7 })
        // Alcove ammo cache: a crystal cluster glinting in the dark dead-end (by ammo -58.5,51).
        this._put('15_Crystal_Cluster', -59, 52, { size: 3.4, axis: 'y', yaw: -0.6 })
    }

    // 6. Wreck field — the military graveyard. Hulks as hard cover; the beast prowls here.
    _wreckField(){
        this._put('18_Wreckage', -88, 12, { size: 12, axis: 'z', yaw: 2.2, sink: 0.3 })
        this._put('18_Wreckage', -66, -9, { size: 9, axis: 'z', yaw: 5.1, sink: 0.25 })
        // Generator cluster (replaces the two wreck-field generator boxes).
        this._put('17_Tech_Pod', -78, 10, { size: 3.2, axis: 'max', yaw: 0.3 })
        this._put('20_Tech_Crate', -75.6, 11.5, { size: 1.8, axis: 'x', yaw: 0.9 })
        // South barricade line cover.
        this._put('05_Barrier_Wall', -74, -14, { size: 3.3, axis: 'x', yaw: 0.35 })
        this._put('05_Barrier_Wall', -82, -18, { size: 3.0, axis: 'x', yaw: 0.1 })
        // Ammo cache crate (wreck-field ammo at -81,7).
        this._put('20_Tech_Crate', -81, 7, { size: 1.5, axis: 'x', yaw: 0.6 })
    }

    // 7. Switchbacks — the vista spur breather + the watchtower decision point.
    _switchbacks(){
        // Vista spur marker (by the spur ammo/breather at -82,-111).
        this._put('19_Marker_Post', -80.5, -110.5, { size: 4.6, axis: 'y', yaw: 0.75 })
        this._put('20_Tech_Crate', -82, -111, { size: 1.5, axis: 'x', yaw: -0.4 })
    }

    // 8. Gate courtyard — the fortified last stand. Cover crates + a decorative broken stair.
    _gate(){
        this._put('20_Tech_Crate', -132, -224, { size: 1.7, axis: 'x', yaw: 0.9 })
        this._put('05_Barrier_Wall', -143, -222, { size: 3.0, axis: 'x', yaw: -0.4 })
        this._put('16_Broken_Mechanism', -137, -217, { size: 4.0, axis: 'x', yaw: 1.7, sink: 0.2 })
        this._put('08_Tech_Stairs', -131, -230, { size: 5.0, axis: 'z', yaw: 0.5 })
        // Ammo cache crate (gate ammo at -134,-229).
        this._put('20_Tech_Crate', -134, -229, { size: 1.5, axis: 'x', yaw: 0.2 })
    }

    // 9. Summit boss arena — the cyan core among the fallen keep (arena floor datum).
    _summit(){
        const A = CASTLE.arena
        const bossA = Math.atan2(CASTLE.lip.x - A.x, CASTLE.lip.z - A.z) + Math.PI
        const cx = A.x + Math.sin(bossA) * 9, cz = A.z + Math.cos(bossA) * 9
        // Ancient core: a portal pad with a crystal rising from it (replaces the arena tech box).
        this._put('06_Portal_Pad', cx, cz, { size: 6.0, axis: 'max', yaw: 0.8, ground: A.floor + 0.02 })
        this._put('15_Crystal_Cluster', cx, cz, { size: 3.2, axis: 'y', yaw: 0.4, ground: A.floor + 0.3 })
        // Arena cover barriers on the ring lanes.
        this._put('05_Barrier_Wall', A.x + 10, A.z - 3, { size: 3.0, axis: 'x', yaw: 1.1, ground: A.floor })
        this._put('05_Barrier_Wall', A.x - 9, A.z + 6, { size: 2.7, axis: 'x', yaw: -0.5, ground: A.floor })
    }

    // 10. Off-route scatter — dead trees, bones, crystals, mesas, rock platforms. All placed OFF the
    // walkable set (arena skirts, dune flanks) so none needs a collider. Kept clear of the opening
    // vista cone (the start->castle sightline) so the first frame still shows the fortress.
    _scatter(){
        // Dead trees along the early trek edges.
        const trees = [[112, 196, 5.8], [78, 158, 5.0], [46, 152, 5.4], [18, 128, 4.6],
                       [-28, 104, 5.2], [8, 72, 4.4], [-64, 28, 4.8]]
        for(const [x, z, s] of trees){ this._put('14_Dead_Tree', x, z, { size: s, axis: 'y', yaw: x * 0.7 + z }) }

        // Giant bones in the wreck field + dunes (a dead titan motif).
        this._put('12_Bone_Tusk', -95, 20, { size: 5.0, axis: 'y', yaw: 0.6, tilt: [0.15, 0.1] })
        this._put('12_Bone_Tusk', -58, -22, { size: 4.4, axis: 'y', yaw: 2.3, tilt: [0.1, -0.2] })
        this._put('13_Bone_Ribs', -100, -4, { size: 6.5, axis: 'x', yaw: 1.1, sink: 0.3 })
        this._put('13_Bone_Ribs', -70, 22, { size: 5.5, axis: 'x', yaw: -0.7, sink: 0.4 })

        // Crystal accents near the tech thread (off-route glints).
        this._put('15_Crystal_Cluster', -30, 70, { size: 2.6, axis: 'y', yaw: 0.9 })
        this._put('15_Crystal_Cluster', -108, -8, { size: 3.0, axis: 'y', yaw: -1.1 })

        // Big landmark mesas + rock platforms, off the corridor and OFF the opening sightline
        // (kept to the flanks / behind arenas).
        this._put('11_Red_Mesa', 60, 214, { size: 18, axis: 'max', yaw: 0.5 })
        this._put('11_Red_Mesa', -54, 118, { size: 20, axis: 'max', yaw: 2.1 })
        this._put('11_Red_Mesa', -118, -58, { size: 22, axis: 'max', yaw: 1.2 })
        this._put('10_Red_Rock_Platform', -20, 66, { size: 7, axis: 'max', yaw: 0.3, sink: 0.2 })
        this._put('10_Red_Rock_Platform', 40, 108, { size: 6.5, axis: 'max', yaw: 1.4, sink: 0.2 })

        // A hanging ceiling-anchor mass as a broken pylon off the ruins.
        this._put('03_Ceiling_Anchor', -32, 96, { size: 5.5, axis: 'y', yaw: 1.0, tilt: [0.12, 0.08] })
    }

    Update(){}

    Dispose(){
        this.scene.remove(this.root)
        this.root.traverse((n) => { if(n.isMesh && n.geometry){ n.geometry.dispose() } })
    }
}
