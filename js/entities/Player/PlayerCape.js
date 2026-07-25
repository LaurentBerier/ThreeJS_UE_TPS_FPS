import * as THREE from 'three'
import Component from '../../Component.js'
import { ClothSim } from '../World/FlagCloth.js'
import { PALETTE, gradeCharacter, windDirection, windStrengthAt, WIND_SPEED } from '../World/DesertLook.js'
import { installProximityDither } from '../Common/CameraDither.js'


// The player's cape: the ClothSim verlet grid from FlagCloth, mounted on the rig with a
// BONE-WEIGHTED COLLAR and dressed with a fine ripple detail layer. Three layers, top to bottom:
//
//   COLLAR (rows 0..7) — kinematically driven by the skeleton: a mount frame is rebuilt every
//     frame from the two shoulder joints and the upper spine (spine_03), the top corners are
//     HARD-pinned onto the shoulder-plate tops, and the next rows blend from bone-follow into
//     free cloth (weights 1.0 → 0.07 over eight rows). This is "skin weighting" for a sim: the
//     cape reads as bolted to the armor, follows aim leans and crouches exactly, and hands the
//     motion over to the physics smoothly instead of at a hinge line, over more of its length.
//   BASE SIM — the verlet grid (bend-stiffened, capsule-collided, apparent-wind driven) that owns
//     the big hero shapes: the billow, the stream, the settle.
//   DETAIL RIPPLE — a render-time displacement along the cloth normals: two crossed travelling
//     waves, amplitude fading in below the collar and growing toward the hem, speed riding the
//     gust envelope. The base sim can come to rest; this layer never does — the cape always
//     carries the fine anime-style life the reference boards show, at zero solver cost.
//
//   * APPARENT WIND. The cloth answers world-wind MINUS the wearer's velocity, measured from the
//     mount midpoint itself (so slides, jumps, knockbacks and terrain-conform bobs all register,
//     not just intentional locomotion). Sprinting into the citadel wind stacks both.
//   * BODY PUSHOUT against the real PlayerPhysics capsule (crouch-aware), radius ramped in below
//     the collar so it never fights the mount.
//   * GROUND CLAMP against Terrain.HeightAt — crouches and slides drape the hem on the sand.
//
// Safety contract, same as the flags: no physics bodies, no navmesh impact, no UE export. It
// renders in both camera modes like the body does; in FPS the collar dissolves with the head
// (PlayerBody.InstallHeadDither) so cloth never smears across the first-person lens.

const COLS = 13           // across the shoulders
const ROWS = 24           // down the back
const SPACING = 0.055     // metres — ≈0.66 m wide, ≈1.27 m long at a resolution that curves
const PHASE = 0.77        // flutter/gust de-sync from the world's banner flags

// Collar: how many rows the skeleton drives, and how hard. Row 0 is pinned outright; the rest
// lerp toward their bone-space rest pose after every substep. The falloff is what "heavily
// smooths" the joint between armor and airborne cloth. EIGHT rows deep — the whole upper third of
// the cape is strongly bone-led, which both reads as "worn on the armor" and drags the cloth
// mass around with fast turns instead of leaving it to be swept through the body.
// (Reverted from the v5 narrow-clasp/100-90-80 variant at the user's direction while hunting a
// persistent "weird movement": that variant gathered 0.66 m of cloth into a ~0.2 m clasp with
// two fully rigid rows, leaving the collar's links permanently over-compressed and fighting the
// kinematic blend — a standing oscillation no noise-layer change could touch. If the narrow
// clasp comes back, it must come WITH a trapezoidal rest shape so the links agree with it.)
// 2026-07-25: user flagged "too much movement on the TOP of the cape" — the upper third, right
// where it leaves the shoulders. Deepened the collar 6 -> 8 rows so the bone-led region reaches
// down over that band and hands off to free cloth lower and more gently, and re-tuned the weight
// ramp. A first pass (0.92->0.16) read as too STIFF, so it was softened to the current ramp
// (0.82->0.07): still a touch tighter than the old 6-row 0.75->0.10 up top so the band stops
// flapping, but rows 3-7 keep real sim life so the upper cape breathes instead of freezing; the
// flying tail is untouched. The rest-shape arrays are extended along the SAME smooth curve (per
// the v5 note — the links must agree with the rest shape), so no tension seam appears.
const COLLAR_ROWS = 8
const KIN_W = [1.0, 0.82, 0.66, 0.50, 0.36, 0.24, 0.14, 0.07]
// Collar rest shape in the mount frame, per row: how far BEHIND the shoulder line each row sits
// (the widthwise flare lives in _colWidth, built in Initialize). A fitted mantle, not a flat sheet.
const COLLAR_BACK = [0.045, 0.100, 0.150, 0.195, 0.235, 0.270, 0.300, 0.325]

// COLLAR WIDTH. The cloth's natural breadth is (COLS-1)*SPACING. The top of the cape is a GATHERED
// yoke whose corners land ON the shoulders: the top-row width is measured from the live shoulder
// sockets at Initialize (upperarm_l..upperarm_r, ~0.385 m on this rig) and it opens to the full
// breadth by the base of the collar -- so the cape gathers at the shoulders and flares to the wide
// banner below, instead of the top corners poking out past them. That measured per-row width is
// also handed to ClothSim as the horizontal rest-length scale (opts.colScale), so the gathered top
// sits at REST instead of over-compressing the links (the "trapezoidal rest shape so the links
// agree with it" the v5 note demanded). See _colWidth, built in Initialize.
const FULL_WIDTH = (COLS - 1) * SPACING           // 0.66 m of cloth, the free breadth below the collar
const SHOULDER_MARGIN = 0.02                       // top corners sit this far outside the sockets (m)

// ARC OPENING at the top edge: a centre-weighted scoop (max at the centre column, zero at the
// shoulder corners, fading out over the collar) that drops the middle of the top edge DOWN and
// pulls it BACK, so the cape parts over the spine and clears the lower back instead of pressing
// a taut sheet into it -- the interpenetration the user flagged.
const ARC_DROP = 0.05     // centre of the top edge dips this far below the shoulder corners (m)
const ARC_BACK = 0.06     // and pulls this much further back for body clearance (m)

export default class PlayerCape extends Component{
    constructor(scene){
        super()
        this.name = 'PlayerCape'
        this.scene = scene
        this.time = 0
        this._settled = false

        // Scratch vectors — Update runs per frame; nothing here allocates in steady state.
        this._shL = new THREE.Vector3()
        this._shR = new THREE.Vector3()
        this._sp3 = new THREE.Vector3()
        this._mid = new THREE.Vector3()
        this._prevMid = new THREE.Vector3()
        this._right = new THREE.Vector3()
        this._back = new THREE.Vector3()
        this._upM = new THREE.Vector3()
        this._up = new THREE.Vector3(0, 1, 0)
        this._wind = new THREE.Vector3()
        this._vel = new THREE.Vector3()
        this._pin = new THREE.Vector3()
        this._tRow = new THREE.Vector3()
        this._tCol = new THREE.Vector3()
        this._nrm = new THREE.Vector3()
        this._prevYaw = null
    }

    Initialize(){
        this.body = this.GetComponent('PlayerBody')
        this.physics = this.GetComponent('PlayerPhysics')
        const level = this.FindEntity('Level')
        this.terrain = level ? level.GetComponent('Terrain') : null
        if(!this.body || !this.body.model){ return }

        const model = this.body.model
        // Mount bones. The upperarm ORIGINS are the true shoulder sockets (the clavicle origins
        // sit centimetres apart at the spine — measured; pinning there collapses the cloth to a
        // rope). spine_03 gives the mount frame its UP so the collar rides chest leans.
        this.boneShL = model.getObjectByName('upperarm_l') || model.getObjectByName('clavicle_l')
        this.boneShR = model.getObjectByName('upperarm_r') || model.getObjectByName('clavicle_r')
        this.boneSp3 = model.getObjectByName('spine_03') || model.getObjectByName('spine_02')
        if(!this.boneShL || !this.boneShR){
            // A rig without the UE shoulder chain gets no cape rather than a broken one.
            console.warn('[PlayerCape] shoulder bones not found — cape disabled')
            return
        }

        // COLLAR WIDTH anchored to the LIVE shoulder sockets, so the top corners land ON the
        // shoulders whatever the rig's scale. The socket span is invariant to where the model sits
        // (only its scale matters), so a one-time measure here is exact. The top row spans that
        // (+ a small margin), opening to the cloth's full breadth by the base of the collar.
        this.boneShL.updateWorldMatrix(true, false)
        this.boneShR.updateWorldMatrix(true, false)
        const shoulderDist = this.boneShL.getWorldPosition(this._shL)
            .distanceTo(this.boneShR.getWorldPosition(this._shR))
        const topW = Math.min(FULL_WIDTH, shoulderDist + SHOULDER_MARGIN)
        this._colWidth = new Float32Array(COLLAR_ROWS)
        for(let r = 0; r < COLLAR_ROWS; r++){
            const s = THREE.MathUtils.smoothstep(r, 0, COLLAR_ROWS - 1)   // 0 at the pin, 1 at the base
            this._colWidth[r] = THREE.MathUtils.lerp(topW, FULL_WIDTH, s)
        }

        // Grid seeded roughly behind the spawn pose; the first Update snaps the collar to the
        // real mount and runs a settle pass, so the seed only has to be non-degenerate.
        // bend:true — flexural stiffness. Without it a cape this long folds to a zero-volume
        // crumple against the back the moment the wind drops; the bend web is what keeps the
        // broad hero silhouette between gusts.
        const origin = new THREE.Vector3().copy(this.parent.Position).add(new THREE.Vector3(0, 1.45, 0))
        // Horizontal rest scale = each collar row's width / full breadth, so the gathered top sits
        // at REST instead of fighting the pin; full breadth (scale 1) everywhere below the collar.
        const colScale = new Float64Array(ROWS)
        for(let r = 0; r < ROWS; r++){
            colScale[r] = (r < COLLAR_ROWS ? this._colWidth[r] : FULL_WIDTH) / FULL_WIDTH
        }
        this.sim = new ClothSim(COLS, ROWS, SPACING, origin, windDirection(), { bend: true, colScale })

        // WIND SHADOW of the torso (per-node wind/damping profiles, see ClothSim.step opts).
        // The upper and mid drape hangs against the wearer's back, where the body blocks the
        // stream — it should barely answer the wind and carry no big swinging shapes of its
        // own; the free tail sticks out past the body into clean air and does all the flying.
        // One smooth ramp each, so the calm region blends into the lively one with no seam:
        //   wind: 10% of the stream through the mounted half, ramping to full over u 0.40→0.85;
        //   damp: extra velocity damping near the mount (x0.96 on the base 0.958) fading to
        //         none by mid-cape — kills residual pendulum swing where cloth should sit.
        const n = COLS * ROWS
        this._nodeWind = new Float64Array(n)
        this._nodeDamp = new Float64Array(n)
        for(let r = 0; r < ROWS; r++){
            const u = r / (ROWS - 1)
            const ws = 0.10 + 0.90 * THREE.MathUtils.smoothstep(u, 0.40, 0.85)
            const ds = THREE.MathUtils.lerp(0.960, 1.0, THREE.MathUtils.smoothstep(u, 0.15, 0.60))
            for(let c = 0; c < COLS; c++){
                this._nodeWind[r * COLS + c] = ws
                this._nodeDamp[r * COLS + c] = ds
            }
        }

        // Mesh: triangulated grid, double-sided.
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COLS * ROWS * 3), 3))
        // Static UVs, CROPPED to the cape's measured alpha bounding box in the texture so the
        // banner fills the mesh with almost no stretch (bbox aspect 0.588 ~= mesh aspect 0.569; a
        // full-image map stretched it ~1.75x tall). u spans the cape's left/right edges, v spans
        // its top stitch down to the hem tatters. flipY (loader default) puts the image top at
        // v = 1, so row 0 (the collar) takes the high v. These never change as the sim deforms.
        const U0 = 0.224, U1 = 0.782      // cape L/R edges (measured, + small margin)
        const V0 = 0.034, V1 = 0.972      // hem .. top edge, in flipped-v space
        const uv = new Float32Array(COLS * ROWS * 2)
        for(let r = 0; r < ROWS; r++){
            const vg = 1 - r / (ROWS - 1)          // 1 at the collar (row 0), 0 at the hem
            for(let c = 0; c < COLS; c++){
                const k = (r * COLS + c) * 2
                uv[k]     = U0 + (U1 - U0) * (c / (COLS - 1))
                uv[k + 1] = V0 + (V1 - V0) * vg
            }
        }
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
        const idx = []
        for(let r = 0; r < ROWS - 1; r++){
            for(let c = 0; c < COLS - 1; c++){
                const a = r * COLS + c, b = a + 1, d = a + COLS, e = d + 1
                idx.push(a, d, b, b, d, e)
            }
        }
        geo.setIndex(idx)

        // Rim stays a TRACE (0.12): a billowing sheet sits at grazing incidence across nearly all
        // of its area, so a stronger fresnel rim washes the whole cloth to pale peach regardless of
        // the albedo underneath. The texture, not the rim, is the cape's colour now.
        // The BLACK HIVE cape albedo (assets/characters/black_hive_cape.png): weathered rust
        // leather with the hive glyph, stitched borders and a torn hem, on a TRANSPARENT ground.
        // alphaTest carves the whole silhouette out of the flat grid — the arc neckline, the
        // tapered sides, the hem tatters and the interior holes — so the mesh is just a canvas the
        // texture shapes. (The transparent neckline is also why the top no longer interpenetrates:
        // the cloth that used to press into the spine is simply not drawn there.)
        const tex = new THREE.TextureLoader().load('assets/characters/black_hive_cape.png')
        tex.encoding = THREE.sRGBEncoding
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
        const mat = new THREE.MeshStandardMaterial({
            map: tex, color: 0xffffff, roughness: 0.9, metalness: 0.0,
            side: THREE.DoubleSide, alphaTest: 0.5,
        })
        // Keep the shared character grade (dust + fog clock + a trace readability rim), but lighter
        // on the dust now that the albedo carries its own weathering.
        gradeCharacter(mat, { rimStrength: 0.12, dust: 0.35, dustTop: 1.1, key: 'player-cape' })
        // TPS: dissolve if the boom ever dollies right into the player's back.
        installProximityDither(mat, { near: 0.30, far: 0.85 })
        // FPS: the collar sits just behind the head — dissolve it with the head sphere so the
        // cape can never smear across the first-person lens.
        if(this.body.InstallHeadDither){ this.body.InstallHeadDither(mat) }

        const mesh = new THREE.Mesh(geo, mat)
        mesh.frustumCulled = false          // its bounds move every frame, like the flags
        mesh.castShadow = true
        mesh.receiveShadow = false
        mesh.userData.noExport = true
        mesh.userData.noDecal = true        // bullet decals project onto bodies, not onto cloth
        // Shadows must respect the alpha cutout too, or a tattered cape throws a solid rectangular
        // shadow. A depth material sampling the same map + alphaTest fixes it (double-sided so the
        // back face occludes as well).
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5, side: THREE.DoubleSide,
        })
        this.scene.add(mesh)
        this.geo = geo
        this.mesh = mesh
    }

    // The mount frame: origin on TOP of the shoulder plates, axes from the live skeleton.
    // right = shoulder line, up = chest direction (spine_03 -> shoulder mid, blended toward
    // world-up so a deep aim lean tilts the collar without capsizing it), back = their normal.
    // Pure geometry — no yaw/axis conventions to get wrong per rig.
    _ComputeMount(){
        this.boneShL.updateWorldMatrix(true, false)
        this.boneShR.updateWorldMatrix(true, false)
        this.boneShL.getWorldPosition(this._shL)
        this.boneShR.getWorldPosition(this._shR)

        this._mid.addVectors(this._shL, this._shR).multiplyScalar(0.5)

        // Chest up: from the upper spine to the shoulder midpoint. 65/35 with world up keeps the
        // collar seated through leans without following every breath verbatim.
        if(this.boneSp3){
            this.boneSp3.updateWorldMatrix(true, false)
            this.boneSp3.getWorldPosition(this._sp3)
            this._upM.subVectors(this._mid, this._sp3).normalize()
            this._upM.lerp(this._up, 0.35).normalize()
        }else{
            this._upM.copy(this._up)
        }

        this._right.subVectors(this._shR, this._shL)
        if(this._right.lengthSq() < 1e-6){ this._right.set(1, 0, 0) }
        this._right.normalize()
        this._back.crossVectors(this._right, this._upM).normalize()
        // Re-orthogonalise right against the (possibly leaned) up so the frame stays square.
        this._right.crossVectors(this._upM, this._back).normalize()

        // Seat the mount-frame origin half a plate above the shoulder joint line. The collar WIDTH
        // is measured once from the shoulder sockets at Initialize (this._colWidth) and baked into
        // the rest lengths, so it stays fixed here rather than tracking the per-frame span.
        this._mid.addScaledVector(this._upM, 0.055)
    }

    // World-space rest target for a COLLAR node — the pose the skeleton wants it in.
    _MountTarget(r, c, out){
        const t = c / (COLS - 1) - 0.5                  // -0.5 .. +0.5 across the width
        const width = this._colWidth[r]                 // gathered at the shoulders -> full breadth
        // Arc opening: 1 at the centre column, 0 at the shoulder corners, fading from the pin down
        // over the collar. Drops the centre of the top edge and pulls it back for body clearance.
        const arc = Math.max(0, 1 - (2 * t) * (2 * t)) * Math.max(0, 1 - r / (COLLAR_ROWS - 1))
        out.copy(this._mid)
            .addScaledVector(this._right, t * width)
            .addScaledVector(this._back, COLLAR_BACK[r] + arc * ARC_BACK)
            .addScaledVector(this._upM, -r * SPACING * 0.92 - arc * ARC_DROP)
        return out
    }

    _PinCollar(){
        // Row 0 is pinned outright — the corners are ON the shoulder mesh, every frame, no lag.
        for(let c = 0; c < COLS; c++){
            this.sim.setPin(c, this._MountTarget(0, c, this._pin))
        }
    }

    // THE 180°-TURN FIX. When the mount yaws, rotate the whole free cloth (positions AND their
    // verlet history, identically) about the capsule's vertical axis by a row-weighted share of
    // that yaw. A rigid rotation about the body axis cannot push cloth THROUGH the body — so the
    // fast part of a snap turn is absorbed by a transform that is penetration-free by
    // construction, and the sim only has to resolve the small residual relative motion instead
    // of being dragged sideways through the capsule interior (which is exactly how tunnelling
    // happened: the radial pushout would then eject trapped nodes out the WRONG side). Weight
    // falls from 1.0 below the collar to ~0.4 at the hem, so the tail still lags and swirls
    // around the turn instead of whipping rigidly with it.
    _FollowYaw(dYaw){
        if(Math.abs(dYaw) < 1e-4){ return }
        const pos = this.sim.pos, prev = this.sim.prev
        const p = this.parent.Position
        for(let r = 1; r < ROWS; r++){
            const lag = THREE.MathUtils.smoothstep(r, COLLAR_ROWS - 1, ROWS - 1)
            const a = dYaw * (1.0 - lag * 0.6)
            const s = Math.sin(a), c = Math.cos(a)
            for(let cc = 0; cc < COLS; cc++){
                const o = (r * COLS + cc) * 3
                let dx = pos[o] - p.x, dz = pos[o + 2] - p.z
                pos[o] = p.x + dx * c + dz * s
                pos[o + 2] = p.z - dx * s + dz * c
                dx = prev[o] - p.x; dz = prev[o + 2] - p.z
                prev[o] = p.x + dx * c + dz * s
                prev[o + 2] = p.z - dx * s + dz * c
            }
        }
    }

    // Soft rows: after each substep, pull rows 1..7 toward their bone pose by their weight.
    // Post-step blending acts like a critically-damped spring at these weights — the "heavily
    // smoothed" connection — while everything below the collar stays pure simulation.
    _BlendCollar(){
        const pos = this.sim.pos
        for(let r = 1; r < COLLAR_ROWS; r++){
            const w = KIN_W[r]
            for(let c = 0; c < COLS; c++){
                const o = (r * COLS + c) * 3
                this._MountTarget(r, c, this._pin)
                pos[o]     += (this._pin.x - pos[o]) * w
                pos[o + 1] += (this._pin.y - pos[o + 1]) * w
                pos[o + 2] += (this._pin.z - pos[o + 2]) * w
            }
        }
    }

    // Pushout against the PLAYER CAPSULE (the same shape the physics world resolves the body
    // with — radius/heights read from PlayerPhysics, crouch-aware via the body's eased blend),
    // then the ground clamp. Collision-last is what guarantees the cloth NEVER renders inside
    // the body.
    _Collide(){
        const pos = this.sim.pos
        const n = COLS * ROWS
        const p = this.parent.Position                 // capsule CENTRE (the physics body origin)
        const phys = this.physics
        const radius = (phys && phys.radius) || 0.30
        const standH = (phys && phys.standHeight) || 1.3
        const crouchH = (phys && phys.crouchHeight) || 0.7
        const crouch = this.body && this.body._crouchEased ? this.body._crouchEased : 0
        const halfCyl = THREE.MathUtils.lerp(standH, crouchH, crouch) * 0.5
        for(let i = 0; i < n; i++){
            // The collar is bone-driven and sits inside the capsule's clearance by construction —
            // pushing it out would fight the mount. Ramp the pushout radius in below it.
            const row = (i / COLS) | 0
            const r = (radius + 0.05) * Math.min(1, (row - (COLLAR_ROWS - 1)) / 4)
            if(r <= 0){ continue }
            const o = i * 3
            const cy = Math.max(p.y - halfCyl, Math.min(p.y + halfCyl, pos[o + 1]))
            const dx = pos[o] - p.x
            const dy = pos[o + 1] - cy
            const dz = pos[o + 2] - p.z
            const d2 = dx * dx + dy * dy + dz * dz
            if(d2 < r * r && d2 > 1e-8){
                const d = Math.sqrt(d2)
                const k = r / d
                pos[o]     = p.x + dx * k
                pos[o + 1] = cy + dy * k
                pos[o + 2] = p.z + dz * k
            }
        }
        if(this.terrain){
            for(let i = 0; i < n; i++){
                const o = i * 3
                const gy = this.terrain.HeightAt(pos[o], pos[o + 2]) + 0.03
                if(pos[o + 1] < gy){ pos[o + 1] = gy }
            }
        }
    }

    // DETAIL LAYER — write the sim into the geometry with a fine travelling ripple on top.
    // Displacement runs along the cloth's own normals (finite differences on the sim grid), so
    // the waves follow whatever shape the base sim is holding. Amplitude fades in just below the
    // shoulders and rolls DOWN the whole drape to the hem (a top-to-bottom travelling wave), and
    // swells with the gust envelope; two crossed wave trains keep it from ever reading as a loop.
    //
    // This was the ORIGINAL calm layer, restored verbatim after every added modulation scheme
    // (amplitude cycles, speed wander, mix cross-fades, red-spectrum envelope) read as LESS
    // natural in live A/Bs. 2026-07-25: broadened the amplitude envelope UP the cape and made the
    // downward crest dominant, on a direct reference (the wave must flow top -> hem) — NOT a noise
    // tweak. The calm-layer caution still holds for the wave NUMBERS (speed, frequency, mix): those
    // stay tuned in tiny steps.
    _WriteGeometry(gustN){
        const src = this.sim.pos
        const dst = this.geo.attributes.position.array
        const t = this.time
        // Calm layer (tuned down from the first pass, which read as the whole cape vibrating):
        // longer, slower waves at about two-thirds the amplitude — surface life, not turbulence.
        // WIND-DRIVEN WAVE SPEED: the crest travels faster in stronger gusts. But the PEAK is
        // kept shallow now. The old 4.2 + 3.0*gustN (peak 7.2) whipped the wave fast enough at
        // full gust to read as high-frequency mathematical noise instead of wind. Lowered the
        // wind VARIATION to 1.2 (peak 5.4) so a gust still visibly speeds the wave without
        // buzzing; the wind now reads more through the sim billow and the amplitude swing than a
        // fast sine. (Base 4.2 is the calm-beat travel, which read fine.)
        const rowSpeed = 4.2 + 1.2 * gustN
        for(let r = 0; r < ROWS; r++){
            // TOP-TO-BOTTOM TRAVELLING WAVE. The crest rolls DOWN the cape, from just below the
            // shoulders to the hem, matching the user's reference arrows. The wave PHASE already
            // travels in +r (downward) via sin(r*0.32 - t*rowSpeed …); this envelope is what makes
            // it VISIBLE along the whole drape instead of only at the tail. Fades in from ~u 0.14
            // (the bolt-on shoulder rows stay clean), then a broad body so one long crest reads the
            // full length, with the hem still liveliest. The bone-led collar's lower rows pick the
            // wave up gently — that IS the "wave coming from the top" the reference shows; the
            // base-sim flapping the collar weights removed was a different, chaotic motion.
            const u = r / (ROWS - 1)
            const onset = THREE.MathUtils.smoothstep(u, 0.14, 0.34)
            const ampRow = onset
                // INTENSITY DIAL for the ripple layer. Split the difference between the loud
                // broadened pass (0.011 + 0.021*u) and the ~35%-down pass (0.007 + 0.014*u):
                // (0.009 + 0.0175*u). First term = the uniform strength that lights the mid/upper
                // drape, second = the extra swing owned by the hem. Drop both together for calmer.
                * (0.009 + 0.0175 * u)
                * (0.55 + 0.45 * gustN)
            for(let c = 0; c < COLS; c++){
                const i = r * COLS + c
                const o = i * 3
                if(ampRow <= 0.0001){
                    dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2]
                    continue
                }
                // Cloth normal from the neighbouring sim nodes.
                const rm = Math.max(0, r - 1) * COLS + c, rp = Math.min(ROWS - 1, r + 1) * COLS + c
                const cm = r * COLS + Math.max(0, c - 1), cp = r * COLS + Math.min(COLS - 1, c + 1)
                this._tRow.set(src[rp * 3] - src[rm * 3], src[rp * 3 + 1] - src[rm * 3 + 1], src[rp * 3 + 2] - src[rm * 3 + 2])
                this._tCol.set(src[cp * 3] - src[cm * 3], src[cp * 3 + 1] - src[cm * 3 + 1], src[cp * 3 + 2] - src[cm * 3 + 2])
                this._nrm.crossVectors(this._tCol, this._tRow)
                const len = this._nrm.length()
                if(len < 1e-6){
                    dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2]
                    continue
                }
                this._nrm.multiplyScalar(1 / len)
                const d = ampRow * (
                    // Downward crest dominates (was 0.62) so the wave reads as flowing top -> hem;
                    // the crossed train (was 0.38) just keeps it from ever settling into a loop.
                    0.72 * Math.sin(r * 0.32 - t * rowSpeed + c * 0.20 + PHASE) +
                    0.28 * Math.sin(c * 0.70 + t * 2.2 + r * 0.24))
                dst[o]     = src[o] + this._nrm.x * d
                dst[o + 1] = src[o + 1] + this._nrm.y * d
                dst[o + 2] = src[o + 2] + this._nrm.z * d
            }
        }
        this.geo.attributes.position.needsUpdate = true
        this.geo.computeVertexNormals()
    }

    Update(t){
        if(!this.sim || !this.mesh){ return }
        this.time += t

        this._ComputeMount()

        // Yaw delta of the mount since last frame — feeds the snap-turn follow (see _FollowYaw).
        const yaw = Math.atan2(this._back.x, this._back.z)
        let dYaw = this._prevYaw === null ? 0 : yaw - this._prevYaw
        if(dYaw > Math.PI){ dYaw -= Math.PI * 2 }
        if(dYaw < -Math.PI){ dYaw += Math.PI * 2 }
        this._prevYaw = yaw
        if(this._settled){ this._FollowYaw(dYaw) }

        // Apparent wind = world wind − mount velocity. Measured off the mount midpoint so every
        // source of body motion registers. Clamped: a teleport/respawn must not read as a 100 m/s
        // gale for one frame.
        if(!this._settled){ this._prevMid.copy(this._mid) }
        this._vel.subVectors(this._mid, this._prevMid).divideScalar(Math.max(t, 1e-4))
        if(this._vel.lengthSq() > 12 * 12){ this._vel.setLength(12) }
        this._prevMid.copy(this._mid)

        const gust = windStrengthAt(this.time + PHASE)
        const gustN = THREE.MathUtils.clamp((gust / WIND_SPEED - 0.32) / 0.80, 0, 1)
        this._wind.copy(windDirection()).multiplyScalar(gust)
        this._wind.addScaledVector(this._vel, -0.9)

        const opts = this._opts || (this._opts = {})
        opts.windVec = this._wind
        opts.aero = 1.6         // a hero cape CATCHES the citadel wind — never dead at idle
        opts.gravity = 0.5      // enough weight to fall back into the long drape between gusts
        opts.rounds = 5         // finer grid + bend web: the extra passes keep the span taut
        opts.damp = 0.958       // heavier fabric — kills the verlet jitter, keeps the big shapes
        opts.nodeWind = this._nodeWind   // torso wind shadow: calm mounted half, flying tail
        opts.nodeDamp = this._nodeDamp

        this._PinCollar()

        // First frame: settle the seed grid into a worn drape before anyone sees it.
        if(!this._settled){
            this._settled = true
            for(let i = 0; i < 50; i++){
                this.sim.step(1 / 60, this.time + i / 60, PHASE, opts)
                this._BlendCollar()
                this._Collide()
            }
        }

        // Two substeps of a clamped dt, same stability contract as the flags.
        const dt = Math.min(t, 1 / 30) / 2
        this.sim.step(dt, this.time, PHASE, opts)
        this._BlendCollar()
        this._Collide()
        this.sim.step(dt, this.time + dt, PHASE, opts)
        this._BlendCollar()
        this._Collide()

        this._WriteGeometry(gustN)
    }

    Dispose(){
        if(this.mesh){
            this.scene.remove(this.mesh)
            this.geo.dispose()
            this.mesh.material.dispose()
        }
    }
}
