import * as THREE from 'three'
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import Component from '../../Component.js'
import { PALETTE, GLSL_NOISE, GLSL_SKY, GLSL_ENCODE, sunDirection, PLAY_CENTER, PLAY_RADIUS } from './DesertLook.js'


// The world beyond the journey: dunes to the horizon, dark rock ridges, buried ruins, broken
// arches and abandoned military hulks. (The colossal ruined castle is no longer faked out here —
// it is REAL, playable geometry on its own hill inside the level; see World/Structures.js. This
// file now supplies only the endless desert the journey is read against.)
//
// SAFETY CONTRACT — this is the part of the overhaul with the most potential to break the game, so
// the rules are absolute and enforced by construction in _adopt():
//
//   * NOTHING here gets a physics body. Not one. The Ammo world is never touched by this file, so
//     player movement, the capsule, every raycast, the camera boom sweep and the AI navmesh are
//     bit-for-bit unaffected.
//   * NOTHING here is placed within KEEP_CLEAR of the playable footprint. The nearest geometry
//     starts well outside the terrain, so even a decorative silhouette cannot intrude on a
//     sightline, a cover position or a projectile path.
//   * NOTHING here casts or receives shadows — it is all far outside the sun's shadow frustum
//     anyway, and excluding it keeps the shadow pass exactly as expensive as it was before.
//   * EVERYTHING here is flagged userData.noExport, so the P-key UE export still emits only real
//     gameplay geometry.
//
// COST — the entire far world is three merged draw calls and under 40k triangles, none of it
// animated and none of it in the shadow pass. It is cheaper than a single character.

// No decorative OBJECT is ever placed closer than this to the middle of the playable area.
// PLAY_RADIUS already covers the 640 m terrain square's corners (453 m), so every prop ring
// starts beyond real, walkable ground.
const KEEP_CLEAR = PLAY_RADIUS + 40      // ~495 m
// Where the dune SURFACE starts climbing. The flat pad underlies the whole terrain square (whose
// corners reach 453 m) sitting just below the terrain's rim height, so the two surfaces never
// intersect; past this the far dunes rise into the horizon.
const PAD_RADIUS = 462
// Where the dune field stops. Pushed well past the point the haze has fully closed: at 1250 m the
// haze still left about 7% of the last ring showing, which drew a faint but perfectly straight
// line across the horizon. The extra distance costs nothing — the polar grid's outer rings hold the
// same triangle count however far out they sit.
const FAR_EDGE = 2000

// Haze density for far geometry. Thinner than the scene fog the near world uses (0.0028): at 380 m
// this leaves the fortress about 22% hazed — present and solid, with aerial perspective, rather
// than the milky ghost a heavier value produced. Both densities are effectively zero inside combat
// range, so they cannot disagree anywhere the player is actually fighting.
const FAR_HAZE = 0.0013


// Deterministic PRNG. The world must be identical every load — an art-directed skyline that
// reshuffles itself on reload is not a landmark, and it would make visual regressions untraceable.
function makeRng(seed){
    let s = seed >>> 0
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 4294967296
    }
}


export default class FarWorld extends Component{
    constructor(scene, camera){
        super()
        this.name = 'FarWorld'
        this.scene = scene
        this.camera = camera
        this.sunDir = sunDirection()
        this.root = new THREE.Group()
        this.root.name = 'FarWorld'
        this.root.userData.noExport = true
        this.pieces = []
    }

    Initialize(){
        this.material = this._buildMaterial()
        this.scene.add(this.root)

        this._buildDuneField()
        this._buildRidges()
        this._buildRuins()
        this._buildWrecks()
    }

    // One material for the entire far world. Lighting is deliberately NOT three's PBR pipeline:
    // at this distance a full standard material buys nothing, costs a lot, and would drag the far
    // world into the shadow/light uniform machinery. This is a wrapped lambert plus a sun rim,
    // which is what actually sells a backlit silhouette, followed by the same analytic sky the dome
    // is painted with — so a ridge fades into precisely the colour behind it and the horizon has no
    // seam. Surface variety rides on vertex colours, which is what lets everything merge.
    _buildMaterial(){
        const c = (col) => new THREE.Vector3(col.r, col.g, col.b)
        return new THREE.ShaderMaterial({
            fog: false,           // handled below, per view direction, to match the sky exactly
            // Ridges, arches and collapsed walls are open shells, not closed solids — they are
            // lofted strips and stacked slabs, so back-face culling punches holes in them from
            // half the angles in the level. Drawing both sides and flipping the normal in the
            // shader costs nothing at 40k triangles and makes them solid from everywhere.
            side: THREE.DoubleSide,
            uniforms: {
                uSunDir: { value: this.sunDir.clone() },
                uSunCol: { value: c(PALETTE.sun) },
                uAmbCol: { value: c(PALETTE.skyAmbient) },
                uBounce: { value: c(PALETTE.sandBounce) },
                uHaze: { value: FAR_HAZE },
            },
            vertexShader: /* glsl */`
                attribute vec3 color;
                varying vec3 vCol;
                varying vec3 vWorld;
                varying vec3 vNrm;
                void main(){
                    vCol = color;
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vWorld = wp.xyz;
                    vNrm = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * viewMatrix * wp;
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uSunDir;
                uniform vec3 uSunCol;
                uniform vec3 uAmbCol;
                uniform vec3 uBounce;
                uniform float uHaze;
                varying vec3 vCol;
                varying vec3 vWorld;
                varying vec3 vNrm;
                ${GLSL_NOISE}
                ${GLSL_SKY}
                ${GLSL_ENCODE}

                void main(){
                    vec3 N = normalize(vNrm);
                    if(!gl_FrontFacing){ N = -N; }    // see the DoubleSide note on the material
                    vec3 L = normalize(uSunDir);
                    vec3 toCam = cameraPosition - vWorld;
                    float dist = length(toCam);
                    vec3 V = toCam / max(dist, 0.001);

                    // Wrapped diffuse. The wrap stands in for the bounce a real desert throws
                    // around; a hard N.L terminator at this scale reads as flat cardboard. Kept
                    // tight, though — too generous a wrap lit the fortress's shadow side and threw
                    // away the backlit silhouette that makes it a landmark.
                    float ndl = dot(N, L);
                    float diff = clamp(ndl * 0.78 + 0.22, 0.0, 1.0);

                    // Sky ambient above, warm sand bounce below — the same split the near world's
                    // hemisphere light uses, so far and near geometry agree.
                    float up = N.y * 0.5 + 0.5;
                    vec3 amb = mix(uBounce * 0.55, uAmbCol, up);

                    vec3 col = vCol * (uSunCol * diff * 1.25 + amb * 0.5);

                    // Backlit rim. With the sun behind the fortress this is what draws the molten
                    // edge along its towers and turns a grey mass into a silhouette.
                    float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.5);
                    col += uSunCol * rim * clamp(dot(L, -V) * 0.5 + 0.5, 0.0, 1.0) * 0.55;

                    // Atmospheric perspective, blending into the sky in THIS view direction rather
                    // than into a single flat fog colour.
                    float h = 1.0 - exp(-pow(dist * uHaze, 2.0));
                    vec3 sky = dl_skyColor(-V, L);
                    col = mix(col, sky, clamp(h, 0.0, 1.0));

                    gl_FragColor = vec4(dl_toLinear(col), 1.0);
                }
            `,
        })
    }

    // Every piece of far geometry goes through here. Single choke point for the safety contract.
    _adopt(geometry, name){
        const mesh = new THREE.Mesh(geometry, this.material)
        mesh.name = name
        mesh.castShadow = false
        mesh.receiveShadow = false
        mesh.userData.noExport = true
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        this.root.add(mesh)
        this.pieces.push(mesh)
        return mesh
    }

    // ---------------------------------------------------------------------------------------
    // The dune sea. A polar grid whose rings grow geometrically outward, so triangles stay
    // roughly constant in SCREEN size all the way to the horizon — dense where the player can
    // see detail, sparse where they cannot. This is the LOD; no discrete levels needed.
    // ---------------------------------------------------------------------------------------
    _buildDuneField(){
        const RINGS = 96, SEGS = 132
        const positions = [], colors = [], indices = []
        const cx = PLAY_CENTER.x, cz = PLAY_CENTER.y
        const rng = makeRng(1337)
        const jitter = []
        for(let i = 0; i < SEGS; i++){ jitter.push(rng()) }

        for(let r = 0; r <= RINGS; r++){
            // Geometric radial spacing from just under the playable pad out to the haze line.
            const t = r / RINGS
            const radius = 20 * Math.pow(FAR_EDGE / 20, t)
            for(let s = 0; s <= SEGS; s++){
                const a = (s / SEGS) * Math.PI * 2
                const x = cx + Math.cos(a) * radius
                const z = cz + Math.sin(a) * radius
                positions.push(x, this._duneHeight(x - cx, z - cz, radius), z)
                // Sand gets darker and slightly cooler with distance, which reinforces the
                // aerial perspective the haze is already doing.
                const far = Math.min(radius / 700, 1)
                const shade = 0.9 + 0.26 * Math.sin(radius * 0.05 + jitter[s % SEGS] * 6.2)
                // Kept close to the lit sand value. The dune sea is the frame's large bright
                // surface — the thing every dark silhouette, near and far, is read against — so it
                // has to out-value the structures rather than sit level with them.
                const col = PALETTE.sandLit.clone().lerp(PALETTE.sandDark, 0.12 + far * 0.22)
                colors.push(col.r * shade, col.g * shade, col.b * shade)
            }
        }
        const stride = SEGS + 1
        for(let r = 0; r < RINGS; r++){
            for(let s = 0; s < SEGS; s++){
                const a = r * stride + s, b = a + 1, c = a + stride, d = c + 1
                indices.push(a, c, b, b, c, d)
            }
        }

        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
        g.setIndex(indices)
        g.computeVertexNormals()
        this._adopt(g, 'FarDunes')
    }

    // Height of the dune sea at an offset from the middle of the level.
    //
    // Inside the playable radius this sits at DEPOT_PAD, safely BELOW the real terrain's lowest
    // point (-1.1 m), so the two surfaces can never intersect or z-fight; the depot then reads as
    // sitting on a raised pad with a natural scarp at its edge. Outside, it climbs into dunes.
    _duneHeight(dx, dz, radius){
        // Just under the journey terrain's rim height (WORLD.rim = -1.2 m at its edges) — close
        // enough that the boundary reads as a low step rather than a floating shelf, far enough
        // that the two surfaces can never intersect or z-fight. The gentle ripple keeps the apron
        // from reading as a dead flat plate; it stays within [-2.3, -1.7] so the no-intersection
        // guarantee holds everywhere under the terrain square.
        const DEPOT_PAD = -2.0 + 0.3 * Math.sin(dx * 0.08) * Math.cos(dz * 0.065)
        if(radius <= PAD_RADIUS){ return DEPOT_PAD }

        // Ramp in over 60 m so the pad edge becomes a slope rather than a wall.
        const blend = Math.min((radius - PAD_RADIUS) / 60, 1)

        // Big rolling dunes, plus a stretched second train crossing them at an angle — real dune
        // seas are two interfering wave systems, not one.
        const a = Math.sin(dx * 0.018 + Math.cos(dz * 0.011) * 2.2) * Math.cos(dz * 0.014)
        const b = Math.sin((dx * 0.6 + dz * 0.8) * 0.037 + 1.7)
        const c = Math.sin((dx * -0.8 + dz * 0.6) * 0.009)
        let h = a * 15 + b * 5.5 + c * 22

        // Dunes grow with distance — the near field stays low so it never rises into the skyline
        // and steals the fortress's silhouette.
        h *= 0.25 + 0.75 * Math.min(radius / 420, 1.6)
        return DEPOT_PAD + blend * (h + 9 * blend)
    }

    // ---------------------------------------------------------------------------------------
    // Dark rocky ridges. Long, low, blade-like masses of the darkest rock in the palette, laid
    // around the horizon to give the dune sea something to break against.
    // ---------------------------------------------------------------------------------------
    _buildRidges(){
        const rng = makeRng(9001)
        const parts = []
        const cx = PLAY_CENTER.x, cz = PLAY_CENTER.y

        for(let i = 0; i < 16; i++){
            const ang = (i / 16) * Math.PI * 2 + rng() * 0.3
            const dist = 640 + rng() * 620
            const len = 120 + rng() * 340
            const height = 18 + rng() * 62
            const width = 40 + rng() * 90
            const x = cx + Math.cos(ang) * dist
            const z = cz + Math.sin(ang) * dist
            // Keep the ridge line off the fortress's bearing so nothing competes with it.
            parts.push(this._ridgeGeometry(len, width, height, rng, x, z, ang + Math.PI * 0.5))
        }
        this._adopt(BufferGeometryUtils.mergeBufferGeometries(parts), 'FarRidges')
    }

    // A ridge is a lofted noisy profile: a spine of segments whose crest height and side slopes
    // vary, skinned as a triangle strip pair. Cheap, and it reads as eroded rock rather than a box.
    _ridgeGeometry(len, width, height, rng, x, z, rot){
        const SEG = 14
        const positions = [], colors = [], indices = []
        const rock = PALETTE.stoneDark
        for(let i = 0; i <= SEG; i++){
            const t = i / SEG
            // Taper to nothing at both ends so ridges bed into the sand instead of stopping dead.
            const taper = Math.sin(t * Math.PI)
            const crest = height * taper * (0.55 + rng() * 0.75)
            const halfW = width * 0.5 * taper * (0.7 + rng() * 0.6)
            const px = (t - 0.5) * len
            const skew = (rng() - 0.5) * width * 0.35
            positions.push(px, 0, skew - halfW)
            positions.push(px, crest, skew + (rng() - 0.5) * halfW * 0.4)
            positions.push(px, 0, skew + halfW)
            const lit = 0.75 + rng() * 0.5
            for(let k = 0; k < 3; k++){
                // Crest catches more light than the flanks — a free ambient-occlusion cue.
                const f = (k === 1 ? 1.35 : 0.8) * lit
                colors.push(rock.r * f, rock.g * f, rock.b * f)
            }
        }
        for(let i = 0; i < SEG; i++){
            const a = i * 3, b = a + 3
            indices.push(a, a + 1, b,      b, a + 1, b + 1)
            indices.push(a + 1, a + 2, b + 1,  b + 1, a + 2, b + 2)
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
        g.setIndex(indices)
        g.computeVertexNormals()
        const m = new THREE.Matrix4()
            .makeRotationY(rot)
            .premultiply(new THREE.Matrix4().makeTranslation(x, this._duneHeight(x - PLAY_CENTER.x, z - PLAY_CENTER.y, Math.hypot(x - PLAY_CENTER.x, z - PLAY_CENTER.y)) - 4, z))
        g.applyMatrix4(m)
        return g
    }

    // Give a primitive geometry a flat vertex colour so it can merge with the rest.
    _paint(geometry, color, shade){
        const col = color.clone().multiplyScalar(shade)
        const n = geometry.attributes.position.count
        const arr = new Float32Array(n * 3)
        for(let i = 0; i < n; i++){ arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b }
        geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3))
        return geometry
    }

    // ---------------------------------------------------------------------------------------
    // Mid-distance ruins: broken arches, half-buried monoliths and collapsed walls. These are
    // what give the eye something to measure distance against between the depot and the fortress.
    // ---------------------------------------------------------------------------------------
    _buildRuins(){
        const rng = makeRng(777)
        const parts = []
        const cx = PLAY_CENTER.x, cz = PLAY_CENTER.y
        const stone = PALETTE.stoneDark
        const bronze = PALETTE.bronze

        const place = (g, x, z, rotY, sink) => {
            const y = this._duneHeight(x - cx, z - cz, Math.hypot(x - cx, z - cz)) - sink
            g.applyMatrix4(new THREE.Matrix4().makeRotationY(rotY)
                .premultiply(new THREE.Matrix4().makeTranslation(x, y, z)))
            parts.push(g)
        }

        for(let i = 0; i < 26; i++){
            const ang = rng() * Math.PI * 2
            const dist = KEEP_CLEAR + 20 + rng() * 320
            const x = cx + Math.cos(ang) * dist
            const z = cz + Math.sin(ang) * dist
            const rot = rng() * Math.PI * 2
            const kind = rng()

            if(kind < 0.3){
                // Broken arch: two piers and a partial span, one side collapsed.
                const h = 9 + rng() * 16, w = 10 + rng() * 12
                const sub = []
                for(const sx of [-1, 1]){
                    const p = new THREE.BoxGeometry(3, h, 3.4)
                    this._paint(p, stone, 0.62 + rng() * 0.2)
                    p.applyMatrix4(new THREE.Matrix4().makeTranslation(sx * w * 0.5, h / 2, 0))
                    sub.push(p)
                }
                // Stepped span, deliberately incomplete.
                const steps = 3 + Math.floor(rng() * 3)
                for(let s = 0; s < steps; s++){
                    const b = new THREE.BoxGeometry(w * 0.34, 2.2, 3.4)
                    this._paint(b, stone, 0.7)
                    const t = (s / Math.max(steps - 1, 1) - 0.5)
                    b.applyMatrix4(new THREE.Matrix4().makeTranslation(t * w * 0.72, h + 1.2 - Math.abs(t) * 3.5, 0))
                    sub.push(b)
                }
                place(BufferGeometryUtils.mergeBufferGeometries(sub), x, z, rot, 1.5)
            }else if(kind < 0.62){
                // Monolith / stele, leaning and half-buried.
                const h = 12 + rng() * 26
                const g = new THREE.BoxGeometry(4 + rng() * 5, h, 2.5 + rng() * 3)
                this._paint(g, stone, 0.55 + rng() * 0.25)
                g.applyMatrix4(new THREE.Matrix4().makeRotationZ((rng() - 0.5) * 0.5)
                    .premultiply(new THREE.Matrix4().makeTranslation(0, h * 0.4, 0)))
                place(g, x, z, rot, 2.5)
            }else{
                // Collapsed wall run — a line of blocks progressively sinking into the sand.
                const sub = []
                const n = 4 + Math.floor(rng() * 6)
                for(let s = 0; s < n; s++){
                    const hh = (7 + rng() * 9) * (1 - s / (n + 2))
                    const b = new THREE.BoxGeometry(6 + rng() * 4, Math.max(hh, 1.2), 3)
                    this._paint(b, rng() < 0.2 ? bronze : stone, 0.55 + rng() * 0.3)
                    b.applyMatrix4(new THREE.Matrix4().makeRotationZ((rng() - 0.5) * 0.25)
                        .premultiply(new THREE.Matrix4().makeTranslation(s * 7.2, hh * 0.4, (rng() - 0.5) * 2)))
                    sub.push(b)
                }
                place(BufferGeometryUtils.mergeBufferGeometries(sub), x, z, rot, 1.2)
            }
        }
        this._adopt(BufferGeometryUtils.mergeBufferGeometries(parts), 'FarRuins')
    }

    // ---------------------------------------------------------------------------------------
    // Abandoned military technology: hulls, gantries and antenna masts sunk in the sand. Angular
    // and man-made, so they read as a different civilisation's leavings than the stone ruins.
    // ---------------------------------------------------------------------------------------
    _buildWrecks(){
        const rng = makeRng(31337)
        const parts = []
        const cx = PLAY_CENTER.x, cz = PLAY_CENTER.y
        const steel = PALETTE.steelBlack.clone().lerp(PALETTE.rust, 0.45)

        for(let i = 0; i < 14; i++){
            const ang = rng() * Math.PI * 2
            const dist = KEEP_CLEAR + 30 + rng() * 300
            const x = cx + Math.cos(ang) * dist
            const z = cz + Math.sin(ang) * dist
            const sub = []
            // Kept modest. An earlier pass scaled these up to 35 m and they read as flat plates
            // floating on the sand rather than as wrecks — at these distances a hulk needs to be
            // small enough that the dunes swallow most of it.
            const scale = 0.45 + rng() * 0.7

            // Hull: a long angular body, canted over and part-buried.
            const hull = new THREE.BoxGeometry(20 * scale, 7 * scale, 7 * scale)
            this._paint(hull, steel, 0.7 + rng() * 0.3)
            sub.push(hull)
            // Superstructure, stepped so the silhouette is not one slab.
            const sup = new THREE.BoxGeometry(7 * scale, 5.5 * scale, 6 * scale)
            this._paint(sup, steel, 0.9)
            sup.applyMatrix4(new THREE.Matrix4().makeTranslation(-3 * scale, 5.5 * scale, 0))
            sub.push(sup)
            const cab = new THREE.BoxGeometry(4 * scale, 3.5 * scale, 4.5 * scale)
            this._paint(cab, steel, 1.05)
            cab.applyMatrix4(new THREE.Matrix4().makeTranslation(-3.5 * scale, 9.8 * scale, 0))
            sub.push(cab)
            // Sponsons / track guards break the box read.
            for(const sz of [-1, 1]){
                const sp = new THREE.BoxGeometry(15 * scale, 2.2 * scale, 1.8 * scale)
                this._paint(sp, steel, 0.6)
                sp.applyMatrix4(new THREE.Matrix4().makeTranslation(1 * scale, 1.2 * scale, sz * 4.2 * scale))
                sub.push(sp)
            }
            // A canted mast — the vertical that makes a wreck legible at distance.
            if(rng() < 0.8){
                const mast = new THREE.CylinderGeometry(0.3 * scale, 0.45 * scale, 22 * scale, 5)
                this._paint(mast, steel, 1.15)
                mast.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.25 + rng() * 0.55)
                    .premultiply(new THREE.Matrix4().makeTranslation(2 * scale, 13 * scale, 0)))
                sub.push(mast)
            }
            const g = BufferGeometryUtils.mergeBufferGeometries(sub)
            // Sunk deep: half-buried is what makes it read as abandoned rather than parked.
            const y = this._duneHeight(x - cx, z - cz, dist) - 3.4 * scale
            g.applyMatrix4(new THREE.Matrix4().makeRotationZ((rng() - 0.5) * 0.45)
                .premultiply(new THREE.Matrix4().makeRotationY(rng() * Math.PI * 2))
                .premultiply(new THREE.Matrix4().makeTranslation(x, y, z)))
            parts.push(g)
        }
        this._adopt(BufferGeometryUtils.mergeBufferGeometries(parts), 'FarWrecks')
    }

    Dispose(){
        for(const m of this.pieces){ m.geometry.dispose() }
        if(this.material){ this.material.dispose() }
        this.scene.remove(this.root)
    }
}
