import * as THREE from 'three'
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import Component from '../../Component.js'
import { Ammo } from '../../AmmoLib.js'
import { PALETTE, gradeRuin, captureFogUniforms } from './DesertLook.js'
import { CASTLE } from './JourneyWorld.js'

// Every built thing the player can touch on the journey: the ruined castle and its boss arena,
// the gate, arches, collapsed walls, pillars, barricades, wreck hulks, pipes, machinery, stairs,
// parapets, banners and the sparse cyan tech accents.
//
// CONTRACTS (these are what keep the rebuild from breaking the game):
//
//   * Anything a bullet, the camera boom, the player capsule or an AI ray can plausibly meet gets
//     a REAL static Ammo collider (box/cylinder), built exactly like the old LevelSetup hulls:
//     mass 0 (StaticFilter), body.parentEntity = the Level entity, body.mesh = a visual mesh — so
//     bullet decals, impact VFX, AI line-of-sight and the TPS camera sweep all work on the new
//     geometry with zero changes to any of those systems.
//   * Every collider records a 2D footprint, consumed by the navmesh generator so AI never paths
//     through a wall. COVER pieces are placed leaving ≥ 2.5 m gaps so the beast (path clearance
//     1.0 m) always has a route around them.
//   * Small combat-adjacent pieces stay STANDALONE meshes so bullet-decal projection stays cheap
//     and works; the big merged castle/ruin shells are flagged noDecal (DecalGeometry walks every
//     triangle of its target — projecting onto a 40k-triangle merged mesh would hitch) — impacts
//     there still get the ImpactFx dust/sparks, which is the read that matters at range.
//   * Purely decorative pieces (banners, emissive strips, high bridge spans' small debris) carry
//     no collider and sit out of every walkable line.
//
// Built in the CONSTRUCTOR (like Terrain) because the navmesh generator needs the footprints
// before the Navmesh component is constructed in entry.js.
export default class Structures extends Component{
    constructor(scene, physicsWorld, terrain, levelEntity = null){
        super()
        this.name = 'Structures'
        this.scene = scene
        this.physicsWorld = physicsWorld
        this.terrain = terrain

        this.footprints = []        // {x, z, hx, hz, cos, sin} — for the navmesh generator
        this.bodies = []
        this.meshes = []
        this.swayShaders = []       // banner shaders that need uTime ticked
        this.time = 0

        // Merge buckets per family for the big shells; standalone pieces render individually.
        this._buckets = { concrete: [], steel: [], bronze: [] }
        this._emissive = []
        this._banners = []

        // Shared graded materials (one program per family for every structure in the level).
        this.mats = {
            concrete: gradeRuin(new THREE.MeshStandardMaterial(), 'concrete'),
            steel:    gradeRuin(new THREE.MeshStandardMaterial(), 'steel'),
            bronze:   gradeRuin(new THREE.MeshStandardMaterial(), 'bronze'),
            // The world's only cool emissive — ancient technology, used sparingly.
            tech: new THREE.MeshStandardMaterial({
                color: 0x041a1e, emissive: PALETTE.techCyan.clone(), emissiveIntensity: 1.25,
                roughness: 0.4, metalness: 0.1,
            }),
            banner: new THREE.MeshStandardMaterial({
                color: 0x3a1712, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide,
            }),
        }

        this.root = new THREE.Group()
        this.root.name = 'Structures'

        this._build()
        this._finalize(levelEntity)
    }

    // Ground height under a point (the piece-footing datum baked into aGroundY).
    _g(x, z){ return this.terrain.HeightAt(x, z) }

    // ---- Piece factories ---------------------------------------------------------------------
    // Every factory takes WORLD-space placement. y is the piece CENTRE (absolute); rot is an
    // Euler (yaw-only for most gameplay pieces; visual tilts allowed anywhere).
    _bakeGround(geom, groundY){
        const n = geom.attributes.position.count
        const arr = new Float32Array(n).fill(groundY)
        geom.setAttribute('aGroundY', new THREE.BufferAttribute(arr, 1))
        return geom
    }

    _place(geom, x, y, z, rot){
        const q = new THREE.Quaternion().setFromEuler(rot || new THREE.Euler())
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1))
        geom.applyMatrix4(m)
        return q
    }

    // A box piece. opts: family, collider (default true), standalone (default false), ground
    // (datum override), noFootprint (collider without navmesh exclusion — overhead spans),
    // visual (default true; false = build the collider + footprint but NO rendered geometry — the
    // piece is now a sculpted WorldProps model, so only its greybox collider survives here).
    box(sx, sy, sz, x, y, z, rot = null, opts = {}){
        const family = opts.family || 'concrete'
        const g = new THREE.BoxGeometry(sx, sy, sz)
        this._bakeGround(g, opts.ground ?? this._g(x, z))
        const q = this._place(g, x, y, z, rot)

        let mesh = null
        if(opts.visual !== false){
            if(opts.standalone){ mesh = this._standalone(g, this.mats[family]) }
            else{ this._buckets[family].push(g) }
        }

        if(opts.collider !== false){
            const body = this._boxCollider(sx / 2, sy / 2, sz / 2, x, y, z, q, opts.noFootprint)
            body._pieceMesh = mesh          // null => resolved to the family shell in Initialize
            body._family = family
        }
        return g
    }

    // A cylinder piece (towers, pillars, masts, pipes). See box() for opts (incl. visual:false).
    cyl(rTop, rBot, h, x, y, z, rot = null, opts = {}){
        const family = opts.family || 'concrete'
        const g = new THREE.CylinderGeometry(rTop, rBot, h, opts.segs || 10)
        this._bakeGround(g, opts.ground ?? this._g(x, z))
        const q = this._place(g, x, y, z, rot)

        let mesh = null
        if(opts.visual !== false){
            if(opts.standalone){ mesh = this._standalone(g, this.mats[family]) }
            else{ this._buckets[family].push(g) }
        }

        if(opts.collider !== false){
            const r = Math.max(rTop, rBot)
            const body = this._cylCollider(r, h / 2, x, y, z, q, opts.noFootprint)
            body._pieceMesh = mesh
            body._family = family
        }
        return g
    }

    _standalone(geom, material){
        const mesh = new THREE.Mesh(geom, material)
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.matrixAutoUpdate = false
        this.root.add(mesh)
        this.meshes.push(mesh)
        return mesh
    }

    // ---- Colliders ----------------------------------------------------------------------------
    _body(shape, x, y, z, q, noFootprint, fpHx, fpHz){
        const transform = new Ammo.btTransform()
        transform.setIdentity()
        transform.setOrigin(new Ammo.btVector3(x, y, z))
        transform.setRotation(new Ammo.btQuaternion(q.x, q.y, q.z, q.w))
        const motionState = new Ammo.btDefaultMotionState(transform)
        const info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, new Ammo.btVector3(0, 0, 0))
        const body = new Ammo.btRigidBody(info)
        body.setFriction(0.9)
        this.physicsWorld.addRigidBody(body)
        this.bodies.push(body)

        if(!noFootprint){
            // Yaw-only footprint: for tilted pieces the XZ extent is conservatively inflated by
            // the caller (fpHx/fpHz are already the rotated half-extents in the piece's yaw frame).
            const e = new THREE.Euler().setFromQuaternion(q, 'YXZ')
            this.footprints.push({ x, z, hx: fpHx, hz: fpHz, cos: Math.cos(e.y), sin: Math.sin(e.y) })
        }
        return body
    }

    _boxCollider(hx, hy, hz, x, y, z, q, noFootprint){
        const shape = new Ammo.btBoxShape(new Ammo.btVector3(hx, hy, hz))
        return this._body(shape, x, y, z, q, noFootprint, hx, hz)
    }

    _cylCollider(r, hh, x, y, z, q, noFootprint){
        const shape = new Ammo.btCylinderShape(new Ammo.btVector3(r, hh, r))
        return this._body(shape, x, y, z, q, noFootprint, r, r)
    }

    // ---- Decorations --------------------------------------------------------------------------
    // A thin cyan-emissive strip (ancient tech seam). Visual only.
    strip(sx, sy, sz, x, y, z, rot = null){
        const g = new THREE.BoxGeometry(sx, sy, sz)
        this._place(g, x, y, z, rot)
        this._emissive.push(g)
    }

    // A torn, markless banner hanging from a wall. Bottom edge jagged, swayed in the vertex
    // shader. Visual only — never in a walk line, never a collider.
    banner(x, y, z, yaw, w = 1.1, h = 2.2){
        const g = new THREE.PlaneGeometry(w, h, 3, 6)
        const pos = g.attributes.position
        const seed = x * 3.1 + z * 1.7
        for(let i = 0; i < pos.count; i++){
            const v = (pos.getY(i) + h / 2) / h            // 0 bottom .. 1 top
            if(v < 0.2){                                    // tear the bottom edge
                pos.setY(i, pos.getY(i) + (Math.sin(seed + i * 7.3) * 0.5 + 0.5) * 0.4 * (0.2 - v) * 5)
            }
        }
        g.computeVertexNormals()
        this._place(g, x, y, z, new THREE.Euler(0, yaw, 0))
        g.userData = { seed }
        this._banners.push(g)
    }

    // ==============================================================================================
    // THE LEVEL
    // ==============================================================================================
    _build(){
        this._startOverlook()
        this._basinArena()
        this._saddle()
        this._ruinsArena()
        this._canyon()
        this._wreckField()
        this._switchbacks()
        this._gateCourtyard()
        this._castle()
    }

    // ---- 1. Start overlook: frame the opening vista, then funnel the player down the ramp. -----
    _startOverlook(){
        const g = (x, z) => this._g(x, z)
        // Two broken arch piers framing the castle bearing (the "look through here" shot).
        const yaw = Math.atan2(CASTLE.x - 150, CASTLE.z - 258)
        const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }
        for(const s of [-1, 1]){
            const px = 145 + right.x * 5.2 * s, pz = 252 + right.z * 5.2 * s
            this.box(1.7, 7.5 + s * 0.9, 1.7, px, g(px, pz) + (7.5 + s * 0.9) / 2, pz,
                new THREE.Euler(0, yaw, 0), { family: 'concrete', standalone: true, visual: false })   // -> WorldProps obelisks
        }
        // A fallen block half-buried at the right pier's foot (grounded — an earlier tilted
        // version floated in the frame and read as a glitch, not a ruin).
        this.box(1.6, 1.3, 1.2, 147.6, g(147.6, 250.4) + 0.35, 250.4,
            new THREE.Euler(0.12, yaw + 0.4, 0.1), { family: 'concrete', standalone: true })
        // A lintel still spanning the piers — the frame the whole journey is first seen through.
        this.box(11.6, 1.4, 1.5, 145, g(145, 252) + 8.2, 252, new THREE.Euler(0, yaw, 0.03),
            { family: 'concrete', noFootprint: true, visual: false })   // -> WorldProps 02_Archway_Lintel
        // Sand-drowned barricades along the plateau rim. Kept OFF the north-east quadrant: the TPS
        // boom swings ~4.5 m behind the spawn, and anything standing there collapses the camera
        // onto the player's shoulder on frame one.
        this.box(3.4, 1.0, 1.0, 156, g(156, 250) + 0.42, 250, new THREE.Euler(0, 0.5, 0), { family: 'steel', standalone: true })
        this.box(3.0, 0.95, 1.0, 142, g(142, 265) + 0.4, 265, new THREE.Euler(0, -0.9, 0), { family: 'steel', standalone: true })
        // A downed antenna mast — old war junk, first hint of the buried military layer.
        this.cyl(0.16, 0.24, 9, 160, g(160, 267) + 0.8, 267,
            new THREE.Euler(0, 0.3, 1.35), { family: 'steel', visual: false })   // -> WorldProps 19_Marker_Post (downed)
        // The torn banner hangs from the lintel, backlit in the frame of the opening shot.
        this.banner(145.8, g(145, 252) + 6.9, 252.8, yaw, 1.2, 2.6)
    }

    // ---- 2. Basin arena: first contact. Long sightlines, sparse cover, one dead hulk. ----------
    _basinArena(){
        const g = (x, z) => this._g(x, z)
        this._wreckHulk(84, 168, 0.9, 1.0, false)               // -> WorldProps 18_Wreckage
        // Cover blocks — spaced ≥ 6 m so every route stays open. (-> WorldProps barriers/crate)
        this.box(2.6, 1.25, 1.4, 100, g(100, 186) + 0.55, 186, new THREE.Euler(0, 0.4, 0), { family: 'concrete', standalone: true, visual: false })
        this.box(2.2, 1.1, 1.3, 92, g(92, 176) + 0.5, 176, new THREE.Euler(0, -0.7, 0), { family: 'concrete', standalone: true, visual: false })
        this.box(2.8, 1.35, 1.5, 104, g(104, 174) + 0.6, 174, new THREE.Euler(0, 1.2, 0), { family: 'bronze', standalone: true, visual: false })
        // Collapsed wall run along the west rim — the arena's long cover line. (-> WorldProps pipe-wall)
        this._wallRun(82, 194, -0.6, 5, 'concrete', false)
    }

    // ---- 3. Saddle: the vista beat. A monolith pair gates the crest; the castle re-appears. ----
    _saddle(){
        const g = (x, z) => this._g(x, z)   // -> WorldProps 01_Obelisk pair
        this.box(1.5, 6.4, 1.1, 38, g(38, 144) + 2.9, 144, new THREE.Euler(0, 0.2, 0.08), { family: 'concrete', standalone: true, visual: false })
        this.box(1.4, 5.6, 1.0, 29, g(29, 137) + 2.5, 137, new THREE.Euler(0, -0.3, -0.06), { family: 'concrete', standalone: true, visual: false })
    }

    // ---- 4. Ruins arena: buried civilisation. Arches + wall lines + pillars = flanking fight. --
    _ruinsArena(){
        const g = (x, z) => this._g(x, z)
        // The grand broken arch — the arena's centrepiece landmark, off the through-line.
        this._brokenArch(-14, 86, 0.7, 11, 9, false)            // -> WorldProps 09_Red_Rock_Arch
        // Wall runs forming two cover lines with a wide lane between them. (-> WorldProps pipe-wall)
        this._wallRun(-2, 100, 0.35, 6, 'concrete', false)
        this._wallRun(4, 80, -1.2, 5, 'concrete', false)
        // Pillars — vertical punctuation the soldiers strafe between. (-> WorldProps 19_Marker_Post)
        this.cyl(0.55, 0.65, 3.2, -10, g(-10, 96) + 1.6, 96, null, { family: 'concrete', standalone: true, visual: false })
        this.cyl(0.5, 0.6, 2.4, 2, g(2, 92) + 1.2, 92, null, { family: 'concrete', standalone: true, visual: false })
        this.cyl(0.55, 0.62, 3.6, -4, g(-4, 78) + 1.8, 78, null, { family: 'concrete', standalone: true, visual: false })
        // Half-buried machinery with a faint tech seam — the "ancient technology" thread starts.
        this.box(2.6, 1.5, 1.8, -18, g(-18, 82) + 0.5, 82, new THREE.Euler(0.12, 2.1, 0), { family: 'steel', standalone: true, visual: false })   // -> WorldProps 16_Broken_Mechanism
        this.strip(0.05, 0.5, 0.06, -16.8, g(-18, 82) + 1.0, 82.4, new THREE.Euler(0.12, 2.1, 0))
        // Overwatch ledge parapet (side path reward position).
        this.box(4.2, 1.05, 0.55, 32, g(32, 92.5) + 0.45, 92.5, new THREE.Euler(0, 0.75, 0), { family: 'concrete', standalone: true })
    }

    // ---- 5. Canyon: the squeeze. Pipes on the walls, a ruined bridge overhead, an ambush. -------
    _canyon(){
        const g = (x, z) => this._g(x, z)
        // Ruined bridge spanning the narrows, high overhead — pure silhouette drama.
        const bx = -42, bz = 40
        const deckY = g(bx, bz) + 13
        this.box(2.2, 9, 2.6, -48.5, deckY - 4.5, 44.5, null, { family: 'concrete' })
        this.box(2.2, 11, 2.6, -35.5, deckY - 5.5, 35.5, null, { family: 'concrete' })
        this.box(7.5, 1.1, 2.4, -46, deckY + 0.5, 42.3, new THREE.Euler(0, 0.65, -0.04), { family: 'concrete', noFootprint: true })
        this.box(5.5, 1.0, 2.4, -37.5, deckY + 0.2, 37.5, new THREE.Euler(0, 0.65, 0.1), { family: 'concrete', noFootprint: true })
        // (the span's central section has fallen — the gap IS the story)

        // Pipes running along the canyon wall base + a vent box, hugging the west wall.
        this.cyl(0.28, 0.28, 16, -46.5, g(-46.5, 45) + 0.6, 45,
            new THREE.Euler(Math.PI / 2 - 0.12, 0.72, 0), { family: 'steel', segs: 8, visual: false })   // -> WorldProps pipe-wall
        this.box(1.4, 1.6, 1.2, -51, g(-51, 49) + 0.7, 49, new THREE.Euler(0, 0.7, 0), { family: 'steel', visual: false })   // -> WorldProps 17_Tech_Pod
        // Ambush barricades at the canyon exit, angled to face the player's approach.
        this.box(3.2, 1.05, 1.0, -55, g(-55, 26) + 0.45, 26, new THREE.Euler(0, 0.85, 0), { family: 'steel', standalone: true })
        this.box(2.8, 1.0, 1.0, -62, g(-62, 20) + 0.42, 20, new THREE.Euler(0, 0.6, 0), { family: 'steel', standalone: true })
        // A slab fallen against the east wall mid-canyon (shape, not obstruction).
        this.box(1.1, 5.2, 2.0, -37.8, g(-37.8, 33) + 2.2, 33, new THREE.Euler(0, 0.7, 0.62), { family: 'concrete' })
    }

    // ---- 6. Wreck field: the military graveyard. Hulks as hard cover; the beast prowls here. ---
    _wreckField(){
        const g = (x, z) => this._g(x, z)
        this._wreckHulk(-88, 12, 2.2, 1.25, false)             // -> WorldProps 18_Wreckage
        this._wreckHulk(-66, -9, 5.1, 1.0, false)              // -> WorldProps 18_Wreckage
        // A crashed gantry: two legs + a fallen truss between them.
        this.cyl(0.3, 0.4, 7, -80, g(-80, -4) + 3.2, -4, new THREE.Euler(0, 0, 0.5), { family: 'steel' })
        this.cyl(0.3, 0.4, 6, -74, g(-74, 0) + 2.6, 0, new THREE.Euler(0.2, 0, -0.4), { family: 'steel' })
        this.box(7.5, 0.7, 0.9, -77, g(-77, -2) + 1.9, -2, new THREE.Euler(0, 0.5, 0.16), { family: 'steel' })
        // Generator block cluster (centre-north cover) with a dying tech seam.
        this.box(2.4, 1.7, 1.9, -78, g(-78, 10) + 0.7, 10, new THREE.Euler(0, 0.3, 0), { family: 'steel', standalone: true, visual: false })   // -> WorldProps 17_Tech_Pod
        this.box(1.6, 1.2, 1.4, -75.6, g(-75.6, 11.5) + 0.5, 11.5, new THREE.Euler(0, 0.9, 0), { family: 'steel', standalone: true, visual: false })   // -> WorldProps 20_Tech_Crate
        this.strip(0.06, 0.4, 0.05, -76.9, g(-78, 10) + 1.1, 10.9, new THREE.Euler(0, 0.3, 0))
        // Cover blocks + the south barricade line (facing the beast's ground). (-> WorldProps barriers)
        this.box(2.7, 1.3, 1.5, -70, g(-70, 6) + 0.55, 6, new THREE.Euler(0, -0.5, 0), { family: 'concrete', standalone: true })
        this.box(3.3, 1.0, 1.0, -74, g(-74, -14) + 0.42, -14, new THREE.Euler(0, 0.35, 0), { family: 'steel', standalone: true, visual: false })
        this.box(3.0, 1.0, 1.0, -82, g(-82, -18) + 0.42, -18, new THREE.Euler(0, 0.1, 0), { family: 'steel', standalone: true, visual: false })
    }

    // ---- 7. Switchbacks: parapets on the outer edges, a watchtower stub at the turn. -----------
    _switchbacks(){
        const g = (x, z) => this._g(x, z)
        const parapet = (x, z, yaw, len = 5.5) =>
            this.box(len, 0.95, 0.5, x, g(x, z) + 0.4, z, new THREE.Euler(0, yaw, 0), { family: 'concrete', standalone: true })
        // Leg B outer edge (the overlook side).
        parapet(-124, -114, 0.9); parapet(-117, -120, 0.9); parapet(-101, -138, 0.75)
        // Leg C outer edge.
        parapet(-126, -152, 0.85); parapet(-135, -160, 0.85)
        // Vista spur parapet — the breather overlook.
        parapet(-79, -109, 0.75, 6.5); parapet(-84.5, -115.5, 0.75, 5)
        this.banner(-80.5, g(-80.5, -110.5) + 2.1, -110.2, 0.75 + Math.PI)
        this.cyl(0.12, 0.12, 4.4, -80.5, g(-80.5, -110.5) + 2.2, -110.5, null, { family: 'steel', segs: 6, visual: false })   // -> WorldProps 19_Marker_Post
        // Watchtower stub at switchback C's hairpin: the decision-point landmark.
        this.cyl(2.1, 2.5, 6.5, -152, g(-152, -172) + 3.2, -172, null, { family: 'bronze', standalone: true })
        this.box(2.2, 0.8, 2.2, -152, g(-152, -172) + 6.9, -172, new THREE.Euler(0, 0.4, 0), { family: 'bronze' })
    }

    // ---- 8. Gate courtyard: the fortified last stand below the summit. -------------------------
    _gateCourtyard(){
        const g = (x, z) => this._g(x, z)
        const yaw = CASTLE.gate.yaw
        const gx = CASTLE.gate.x, gz = CASTLE.gate.z
        const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }

        // The gatehouse: two massive piers flanking a 6 m opening, lintel + stepped arch above.
        for(const s of [-1, 1]){
            const px = gx + right.x * 4.6 * s, pz = gz + right.z * 4.6 * s
            const base = g(px, pz)
            this.box(3.2, 12.5, 3.8, px, base + 6.25, pz, new THREE.Euler(0, yaw, 0), { family: 'concrete', standalone: true })
            // Cyan tech seam inset on each pier's inner face.
            this.strip(0.08, 3.4, 0.1, px - right.x * 1.7 * s, base + 4.6, pz - right.z * 1.7 * s,
                new THREE.Euler(0, yaw, 0))
            this.banner(px - right.x * 1.9 * s, base + 8.6, pz - right.z * 1.9 * s, yaw + Math.PI, 1.2, 3.2)
        }
        this.box(11.5, 1.6, 3.4, gx, g(gx, gz) + 12.2, gz, new THREE.Euler(0, yaw, 0), { family: 'concrete', noFootprint: true })
        for(let i = 0; i < 3; i++){
            this.box(8.5 - i * 2.2, 1.1, 3.0, gx, g(gx, gz) + 13.6 + i * 1.1, gz,
                new THREE.Euler(0, yaw, 0), { family: 'concrete', noFootprint: true })
        }
        // Curtain walls running from the piers out to the terrain bunds — the shoulder is SEALED
        // by architecture, so the only way up is through the gate.
        for(const s of [-1, 1]){
            const wx = gx + right.x * 13.5 * s, wz = gz + right.z * 13.5 * s
            this.box(15, 6.5, 2.2, wx, g(wx, wz) + 3.0, wz, new THREE.Euler(0, yaw, 0), { family: 'concrete' })
            // broken crenellations
            for(let i = 0; i < 4; i++){
                const cx = wx + right.x * (i - 1.5) * 3.4, cz = wz + right.z * (i - 1.5) * 3.4
                if((i + (s > 0 ? 1 : 0)) % 3 === 0){ continue }
                this.box(1.1, 1.0, 1.0, cx, g(wx, wz) + 6.7, cz, new THREE.Euler(0, yaw, 0), { family: 'concrete', collider: false })
            }
        }
        // Courtyard cover: blocks + an overturned machine. (-> WorldProps crate/barrier/mechanism/stairs)
        this.box(2.6, 1.3, 1.5, -132, g(-132, -224) + 0.55, -224, new THREE.Euler(0, 0.9, 0), { family: 'concrete', standalone: true, visual: false })
        this.box(2.3, 1.15, 1.4, -143, g(-143, -222) + 0.5, -222, new THREE.Euler(0, -0.4, 0), { family: 'concrete', standalone: true, visual: false })
        this.box(2.9, 1.6, 1.8, -137, g(-137, -217) + 0.6, -217, new THREE.Euler(0.1, 1.7, 0.08), { family: 'steel', standalone: true, visual: false })
        this.box(3.2, 1.0, 1.0, -131, g(-131, -230) + 0.42, -230, new THREE.Euler(0, 0.5, 0), { family: 'steel', standalone: true, visual: false })
    }

    // ---- 9. The castle: summit boss arena ringed by the ruin itself, the keep behind. ----------
    _castle(){
        const A = CASTLE.arena
        const g = (x, z) => this._g(x, z)

        // --- Curtain wall ring around the arena. Two gaps: the entrance (toward the lip) and the
        // vista breach (toward the sunset) with only a waist-high parapet — the fight is framed
        // against the dune sea and the low sun.
        const entA = Math.atan2(CASTLE.lip.x - A.x, CASTLE.lip.z - A.z)     // entrance bearing
        const exitA = entA + Math.PI * 0.55                                 // victory-stair bearing
        const angDist = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
        const SEGS = 12
        for(let i = 0; i < SEGS; i++){
            const a = (i / SEGS) * Math.PI * 2
            if(angDist(a, entA) < 0.42){ continue }             // entrance gap (the drop-in lip)
            if(angDist(a, exitA) < 0.26){ continue }            // breach the victory stair climbs through
            const vista = angDist(a, entA + Math.PI) < 0.55
            const r = A.r + 2.4
            const wx = A.x + Math.sin(a) * r
            const wz = A.z + Math.cos(a) * r
            const h = vista ? 1.15 : 5.5 + ((i * 37) % 3) * 1.4
            this.box(11.2, h, 2.0, wx, A.floor + h / 2 - 0.3, wz,
                new THREE.Euler(0, a + Math.PI / 2, 0), { family: 'concrete', ground: A.floor })
            if(!vista && i % 2 === 0){
                this.banner(wx - Math.sin(a) * 1.15, A.floor + h - 0.9, wz - Math.cos(a) * 1.15, a + Math.PI, 1.1, 2.6)
            }
        }

        // --- Entrance cheek walls funnel the drop-in and hide the bowl until you commit.
        for(const s of [-1, 1]){
            const ca = entA + s * 0.5
            const wx = A.x + Math.sin(ca) * (A.r + 1.5)
            const wz = A.z + Math.cos(ca) * (A.r + 1.5)
            this.box(6.5, 4.2, 1.8, wx, A.floor + 1.8, wz, new THREE.Euler(0, ca + Math.PI / 2, 0),
                { family: 'concrete', ground: A.floor })
        }

        // --- Arena furniture: readable low cover, wide lanes (the boss's clearance is 1 m; every
        // gap here is ≥ 3 m). Nothing near the centre — that space belongs to the fight.
        const cov = [
            { a: entA + 1.5, r: 10, sx: 2.7, sy: 1.25, sz: 1.4, fam: 'concrete' },
            { a: entA - 1.6, r: 11, sx: 2.4, sy: 1.15, sz: 1.35, fam: 'concrete' },
            { a: entA + 2.7, r: 12.5, sx: 3.0, sy: 1.3, sz: 1.5, fam: 'bronze' },
            { a: entA - 2.8, r: 9, sx: 2.2, sy: 1.1, sz: 1.3, fam: 'concrete' },
        ]
        for(const c of cov){
            const cx = A.x + Math.sin(c.a) * c.r, cz = A.z + Math.cos(c.a) * c.r
            this.box(c.sx, c.sy, c.sz, cx, A.floor + c.sy / 2 - 0.06, cz,
                new THREE.Euler(0, c.a * 1.7, 0), { family: c.fam, standalone: true, ground: A.floor })
        }
        // Broken pillars near the ring, off the lanes.
        this.cyl(0.6, 0.7, 2.8, A.x + 6.5, A.floor + 1.4, A.z - 12, null, { family: 'concrete', standalone: true, ground: A.floor })
        this.cyl(0.55, 0.66, 2.1, A.x - 10, A.floor + 1.05, A.z + 7, null, { family: 'concrete', standalone: true, ground: A.floor })

        // --- Fallen-keep rubble screening the boss's start (opposite the entrance).
        const bossA = entA + Math.PI
        for(let i = 0; i < 3; i++){
            const ra = bossA + (i - 1) * 0.5
            const rx = A.x + Math.sin(ra) * (A.r - 6.5), rz = A.z + Math.cos(ra) * (A.r - 6.5)
            const s = 2.2 + (i % 2) * 0.9
            this.box(s, s * 0.75, s * 0.8, rx, A.floor + s * 0.3, rz,
                new THREE.Euler(0.2 * (i - 1), ra * 2.3, 0.15), { family: 'concrete', standalone: true, ground: A.floor })
        }

        // --- A cracked ancient core among the rubble — the arena's single cyan accent.
        this.box(0.9, 1.3, 0.9, A.x + Math.sin(bossA) * 9, A.floor + 0.55, A.z + Math.cos(bossA) * 9,
            new THREE.Euler(0.15, 0.8, 0.1), { family: 'steel', standalone: true, ground: A.floor, visual: false })   // -> WorldProps 06_Portal_Pad + 15_Crystal_Cluster
        this.strip(0.06, 0.8, 0.07, A.x + Math.sin(bossA) * 9 + 0.42, A.floor + 0.7, A.z + Math.cos(bossA) * 9,
            new THREE.Euler(0.15, 0.8, 0))

        // --- Victory exit: a stair up through the wall breach, so the arena is escapable AFTER
        // the fight without ever letting the AI out (stairs are structure, not navmesh, and the
        // boss's clamp holds it to the bowl floor). Risers are 0.30 m — comfortably below what
        // the player capsule steps up under drive.
        const exDir = { x: Math.sin(exitA), z: Math.cos(exitA) }
        for(let i = 0; i < 13; i++){
            const sx = A.x + exDir.x * (A.r - 5.2 + i * 0.72)
            const sz = A.z + exDir.z * (A.r - 5.2 + i * 0.72)
            this.box(2.4, 0.5, 1.05, sx, A.floor + 0.05 + i * 0.30, sz,
                new THREE.Euler(0, exitA, 0), { family: 'concrete', ground: A.floor })
        }

        // --- The keep: the colossal mass behind the arena, climbing toward the sun. Backdrop and
        // skyline — outside the wall ring, unreachable, but REAL geometry with real colliders.
        const K = { x: CASTLE.x - Math.sin(entA) * 26, z: CASTLE.z - Math.cos(entA) * 26 }
        const kYaw = entA
        const kg = this._g(K.x, K.z)
        this.box(34, 20, 22, K.x, kg + 10, K.z, new THREE.Euler(0, kYaw, 0), { family: 'concrete' })
        this.box(26, 16, 17, K.x, kg + 27, K.z, new THREE.Euler(0, kYaw, 0), { family: 'concrete', noFootprint: true })
        this.box(18, 13, 13, K.x - Math.sin(kYaw) * 2, kg + 41, K.z - Math.cos(kYaw) * 2,
            new THREE.Euler(0, kYaw, 0), { family: 'concrete', noFootprint: true })

        // Towers: two intact with spires, two snapped. Heights uneven — a ruin's skyline. Sized to
        // DOMINATE: the tallest spire tops out ~95 m over the summit, which is what keeps the
        // silhouette colossal from the start overlook 600 m away.
        const towers = [
            { dx: -16, dz: -7, r: 4.2, h: 58, broken: false },
            { dx: 14, dz: -5, r: 4.8, h: 68, broken: false },
            { dx: -10, dz: 9, r: 3.2, h: 36, broken: true },
            { dx: 10, dz: 10, r: 3.0, h: 42, broken: true },
        ]
        for(const t of towers){
            const tx = K.x + t.dx, tz = K.z + t.dz
            const tg = this._g(tx, tz)
            const shaft = t.broken ? t.h * 0.55 : t.h
            this.cyl(t.r * 0.84, t.r, shaft, tx, tg + shaft / 2, tz, null, { family: 'concrete', segs: 9 })
            if(t.broken){
                for(let i = 0; i < 5; i++){
                    const a = (i / 5) * Math.PI * 2
                    this.box(t.r * 0.5, 1.5 + (i % 3), t.r * 0.5,
                        tx + Math.cos(a) * t.r * 0.6, tg + shaft + 0.8 + (i % 3) * 0.5, tz + Math.sin(a) * t.r * 0.6,
                        new THREE.Euler(0, a, 0), { family: 'concrete', collider: false })
                }
            }else{
                this.box(t.r * 2.5, 1.6, t.r * 2.5, tx, tg + shaft + 0.8, tz, null, { family: 'concrete', collider: false })
                this.cyl(0.25, t.r * 0.95, t.h * 0.5, tx, tg + shaft + 1.6 + t.h * 0.25, tz, null,
                    { family: 'concrete', collider: false, segs: 8 })
            }
        }
        // Flying buttresses off the keep's flanks — the gothic verticals.
        for(let i = 0; i < 6; i++){
            const s = i < 3 ? -1 : 1, k = i % 3
            this.box(1.5, 24, 2.0,
                K.x + Math.cos(kYaw) * (14 + k * 5) * s, kg + 15 + k * 3,
                K.z - Math.sin(kYaw) * (14 + k * 5) * s,
                new THREE.Euler(0, kYaw, s * 0.42), { family: 'concrete', collider: false })
        }
        // Ancient-tech conduits climbing the keep face.
        this.strip(0.16, 16, 0.14, K.x + Math.sin(kYaw) * 11.2 + 4, kg + 15, K.z + Math.cos(kYaw) * 11.2,
            new THREE.Euler(0, kYaw, 0.05))
        this.strip(0.13, 12, 0.11, K.x + Math.sin(kYaw) * 11.2 - 5, kg + 12, K.z + Math.cos(kYaw) * 11.2,
            new THREE.Euler(0, kYaw, -0.04))
        this.banner(K.x + Math.sin(kYaw) * 11.3, kg + 16.5, K.z + Math.cos(kYaw) * 11.3, kYaw, 1.8, 4.8)
    }

    // ---- Kits -----------------------------------------------------------------------------------
    // A collapsed wall: a run of blocks progressively sinking into the sand. vis=false keeps the
    // colliders but hides the greybox (a WorldProps pipe-wall run stands in for it).
    _wallRun(x, z, yaw, n, family, vis = true){
        const dir = { x: Math.sin(yaw + Math.PI / 2), z: Math.cos(yaw + Math.PI / 2) }
        for(let i = 0; i < n; i++){
            const f = 1 - i / (n + 1)
            const h = Math.max(0.9, 2.6 * f)
            const px = x + dir.x * i * 3.1, pz = z + dir.z * i * 3.1
            this.box(3.0, h, 1.1, px, this._g(px, pz) + h / 2 - 0.15, pz,
                new THREE.Euler(0, yaw + (i % 2) * 0.12, 0), { family, standalone: i < 2, visual: vis })
        }
    }

    // A broken arch: two piers, a stepped partial span, one side collapsed. vis=false keeps the
    // pier colliders but hides the greybox (the Red_Rock_Arch prop stands in for it).
    _brokenArch(x, z, yaw, w, h, vis = true){
        const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }
        for(const s of [-1, 1]){
            const px = x + right.x * w * 0.5 * s, pz = z + right.z * w * 0.5 * s
            this.box(2.2, h, 2.6, px, this._g(px, pz) + h / 2 - 0.4, pz,
                new THREE.Euler(0, yaw, 0), { family: 'concrete', standalone: true, visual: vis })
        }
        // Partial span springing from the left pier only.
        for(let i = 0; i < 3; i++){
            const t = -0.5 + i * 0.18
            const px = x + right.x * w * t, pz = z + right.z * w * t
            this.box(w * 0.2, 1.4, 2.4, px, this._g(x, z) + h - 0.6 + i * 0.5, pz,
                new THREE.Euler(0, yaw, 0.12), { family: 'concrete', noFootprint: true, visual: vis })
        }
        // The fallen voussoirs, half-buried where they landed.
        this.box(2.0, 1.4, 1.7, x + right.x * w * 0.2, this._g(x, z) + 0.35, z + right.z * w * 0.2 + 2.4,
            new THREE.Euler(0.3, yaw + 0.7, 0.2), { family: 'concrete', standalone: true, visual: vis })
    }

    // An abandoned military hulk: hull, stepped superstructure, sponsons, canted mast. Gameplay
    // scale, full colliders — this is hard cover the player fights around. vis=false keeps every
    // collider but hides the greybox (a Wreckage prop stands in for it).
    _wreckHulk(x, z, yaw, scale, vis = true){
        const g = this._g(x, z)
        const e = new THREE.Euler(0, yaw, 0.06)
        this.box(9.5 * scale, 3.2 * scale, 3.6 * scale, x, g + 1.1 * scale, z, e, { family: 'steel', standalone: true, visual: vis })
        this.box(3.6 * scale, 2.4 * scale, 3.0 * scale, x - Math.cos(yaw) * 1.6 * scale, g + 3.6 * scale, z + Math.sin(yaw) * 1.6 * scale,
            new THREE.Euler(0, yaw, 0), { family: 'steel', standalone: true, visual: vis })
        this.box(2.0 * scale, 1.5 * scale, 2.2 * scale, x - Math.cos(yaw) * 2.0 * scale, g + 5.4 * scale, z + Math.sin(yaw) * 2.0 * scale,
            new THREE.Euler(0, yaw, 0), { family: 'steel', collider: false, visual: vis })
        for(const s of [-1, 1]){
            this.box(7.0 * scale, 1.0 * scale, 0.9 * scale,
                x + Math.sin(yaw) * 2.1 * scale * s, g + 0.6 * scale, z + Math.cos(yaw) * 2.1 * scale * s,
                e, { family: 'steel', visual: vis })
        }
        this.cyl(0.14 * scale, 0.2 * scale, 8 * scale, x + Math.cos(yaw) * 1.2, g + 4.4 * scale, z - Math.sin(yaw) * 1.2,
            new THREE.Euler(0, yaw, 0.45), { family: 'steel', segs: 6, visual: vis })
        // Faint cyan glow from a still-live cell in the hull crack (kept — it's the tech accent).
        this.strip(0.06, 0.3, 0.05, x + Math.sin(yaw) * 1.9, g + 1.6 * scale, z + Math.cos(yaw) * 1.9,
            new THREE.Euler(0, yaw, 0))
    }

    // ---- Assembly -------------------------------------------------------------------------------
    _finalize(levelEntity){
        // Merge the per-family buckets into one mesh each. Big merged shells skip decal
        // projection (see the header) but still receive dust/sparks via ImpactFx.
        for(const family of ['concrete', 'steel', 'bronze']){
            const bucket = this._buckets[family]
            if(!bucket.length){ continue }
            const merged = BufferGeometryUtils.mergeBufferGeometries(bucket)
            const mesh = new THREE.Mesh(merged, this.mats[family])
            mesh.name = 'Structures_' + family
            mesh.castShadow = true
            mesh.receiveShadow = true
            mesh.matrixAutoUpdate = false
            mesh.userData.noDecal = true
            this.root.add(mesh)
            this.meshes.push(mesh)
        }

        if(this._emissive.length){
            const merged = BufferGeometryUtils.mergeBufferGeometries(this._emissive)
            const mesh = new THREE.Mesh(merged, this.mats.tech)
            mesh.name = 'Structures_tech'
            mesh.matrixAutoUpdate = false
            mesh.userData.noDecal = true
            this.root.add(mesh)
            this.meshes.push(mesh)
        }

        // Banners: one merged mesh, swayed per-vertex in the shader (tear amount rides uv.y).
        if(this._banners.length){
            const merged = BufferGeometryUtils.mergeBufferGeometries(this._banners)
            const mat = this.mats.banner
            mat.onBeforeCompile = (shader) => {
                // Replacing onBeforeCompile bypasses the default fog-clock hook — re-register.
                captureFogUniforms(shader)
                shader.uniforms.uTime = { value: 0 }
                shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    /* glsl */`
                    #include <begin_vertex>
                    {
                        float hang = 1.0 - uv.y;             // 0 at the fixing, 1 at the torn hem
                        float seed = position.x * 1.7 + position.z * 2.3;
                        transformed.x += sin(uTime * 1.9 + seed) * hang * hang * 0.14;
                        transformed.z += cos(uTime * 1.3 + seed * 1.4) * hang * hang * 0.11;
                    }`)
                this.swayShaders.push(shader)
            }
            mat.needsUpdate = true
            const mesh = new THREE.Mesh(merged, mat)
            mesh.name = 'Structures_banners'
            mesh.matrixAutoUpdate = false
            mesh.castShadow = false
            mesh.userData.noDecal = true
            this.root.add(mesh)
            this.meshes.push(mesh)
        }

        this.scene.add(this.root)

        // Family shells for collider->mesh fallback (stamped in Initialize).
        this._shells = {}
        for(const family of ['concrete', 'steel', 'bronze']){
            this._shells[family] = this.meshes.find(m => m.name === 'Structures_' + family) || null
        }
    }

    // Tag every collider exactly as LevelSetup tagged the container hulls: parentEntity (so bullet
    // hits broadcast to the Level entity — decals + ImpactFx) and mesh (the decal projection
    // target — a piece's own standalone mesh where it has one, else the noDecal family shell).
    Initialize(){
        const anyShell = this._shells.concrete || this._shells.steel || this._shells.bronze
        for(const body of this.bodies){
            body.parentEntity = this.parent
            body.mesh = body._pieceMesh || this._shells[body._family] || anyShell
        }
    }

    Update(t){
        this.time += t
        for(const sh of this.swayShaders){ sh.uniforms.uTime.value = this.time }
    }

    Dispose(){
        for(const body of this.bodies){ this.physicsWorld.removeRigidBody(body) }
        this.scene.remove(this.root)
        for(const m of this.meshes){ m.geometry.dispose() }
    }
}
