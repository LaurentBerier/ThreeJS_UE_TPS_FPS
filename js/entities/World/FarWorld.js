import * as THREE from 'three'
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import Component from '../../Component.js'
import { PALETTE, GLSL_NOISE, GLSL_SKY, GLSL_ENCODE, sunDirection, windDirection, PLAY_CENTER, PLAY_RADIUS } from './DesertLook.js'
import { RugDetailTiled } from './JourneyWorld.js'


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

// Haze density for far geometry. Thinner than the scene fog the near world uses: at 380 m this
// leaves the fortress about 22% hazed — present and solid, with aerial perspective, rather than
// the milky ghost a heavier value produced. Both densities are effectively zero inside combat
// range, so they cannot disagree anywhere the player is actually fighting.
// NOTE this is the MID-altitude optical depth: the fragment shader scales it by height — the
// cold mist pools low (dune sea, spire feet) and thins toward the crowns, per the alien-vista
// reference. 0.0013 -> 0.0010 with that change, so spire crowns at ~1200 m stay solid.
const FAR_HAZE = 0.0010


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
    // rugged: the same { albedo, normal, ctrl, meta } bundle the near ground grades with
    // (optional). The far dune sea samples the SAME sheets under mirrored tiling and displaces
    // with the SAME detail field, so near and far read as one continuous map instead of two.
    constructor(scene, camera, rugged = null){
        super()
        this.name = 'FarWorld'
        this.scene = scene
        this.camera = camera
        this.rugged = rugged
        this.sunDir = sunDirection()
        this.root = new THREE.Group()
        this.root.name = 'FarWorld'
        this.root.userData.noExport = true
        this.pieces = []
    }

    Initialize(){
        // Defensive sampler setup: DesertSurfaces configures these same texture objects when it
        // grades the near ground, but FarWorld must not depend on entity-initialisation order —
        // mirrored wrap + flipY are exactly what the far sampling below assumes.
        if(this.rugged){
            for(const t of [this.rugged.albedo, this.rugged.normal, this.rugged.ctrl]){
                if(!t){ this.rugged = null; break }
                t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping
                t.flipY = false
                t.needsUpdate = true
            }
            // The erosion-regime sheet is optional on top of the required trio.
            if(this.rugged && this.rugged.ero){
                const t = this.rugged.ero
                t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping
                t.flipY = false
                t.needsUpdate = true
            }
        }
        this.material = this._buildMaterial()
        this.scene.add(this.root)

        this._buildDuneField()
        this._buildRidges()
        this._buildSpires()
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
        const rug = this.rugged
        const meta = (rug && rug.meta) || {}
        const mean = meta.albedoMeanLinear || [0.4, 0.43, 0.39]
        const meanL = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]
        const uniforms = {
                uSunDir: { value: this.sunDir.clone() },
                uSunCol: { value: c(PALETTE.sun) },
                uAmbCol: { value: c(PALETTE.skyAmbient) },
                uBounce: { value: c(PALETTE.sandBounce) },
                uHaze: { value: FAR_HAZE },
                uMistCol: { value: c(PALETTE.mist) },
                uTime: { value: 0 },       // drives the drifting haze banks (see Update)
        }
        if(rug){
            uniforms.uRugAlb = { value: rug.albedo }
            uniforms.uRugNrm = { value: rug.normal }
            uniforms.uRugCtrl = { value: rug.ctrl }
            uniforms.uRugHalf = { value: (meta.worldSize || 640) / 2 }
            uniforms.uRugSize = { value: meta.worldSize || 640 }
            uniforms.uRugMeanL = { value: meanL }
            if(rug.ero){ uniforms.uRugEro = { value: rug.ero } }
        }
        // The near fog's bank field, verbatim (freq 1/115 m, vertical squashed 2.6x, drifting on
        // the world wind at 2.4 m/s, sampled at the same capped 220 m mid-ray point) — both sides
        // of the fence must agree on where a bank sits or the handoff line reappears as a
        // modulation seam, and the mid-ray cap is what keeps grazing rays over the flat dune pad
        // from striping (see the CUSTOM FOG notes in DesertLook).
        const wv = windDirection()
        const bankGLSL = /* glsl */`
                vec3 bsp = cameraPosition + (vWorld - cameraPosition) * min(1.0, 220.0 / max(dist, 0.001));
                vec3 bnp = (bsp + vec3(${wv.x.toFixed(5)}, 0.0, ${wv.z.toFixed(5)}) * (uTime * 2.4))
                    * vec3(0.008696, 0.022609, 0.008696);
                float bank = dl_noise(bnp) * 0.65 + dl_noise(bnp * 2.7 + 13.1) * 0.35;`
        return new THREE.ShaderMaterial({
            fog: false,           // handled below, per view direction, to match the sky exactly
            // Ridges, arches and collapsed walls are open shells, not closed solids — they are
            // lofted strips and stacked slabs, so back-face culling punches holes in them from
            // half the angles in the level. Drawing both sides and flipping the normal in the
            // shader costs nothing at 40k triangles and makes them solid from everywhere.
            side: THREE.DoubleSide,
            uniforms,
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
                uniform vec3 uMistCol;
                uniform float uTime;
                ${this.rugged ? /* glsl */`
                uniform sampler2D uRugAlb;
                uniform sampler2D uRugNrm;
                uniform sampler2D uRugCtrl;
                uniform float uRugHalf;
                uniform float uRugSize;
                uniform float uRugMeanL;
                ` : ''}
                ${this.rugged && this.rugged.ero ? /* glsl */`
                uniform sampler2D uRugEro;
                ` : ''}
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
                    vec3 alb = vCol;

                    ${this.rugged ? /* glsl */`
                    // Shared erosion language with the playable ground (same sheets, mirror-tiled
                    // by the sampler): residual normals crisp the dune shading, the macro albedo
                    // carries the same staining, drainage lanes darken. Gated to SAND by vertex
                    // colour luminance so the dark rock ridges, the alien spires (lum ≈ 0.25) and
                    // steel wrecks keep their look — dune sand always sits above 0.4 here — and
                    // to up-facing surfaces so lofted walls are untouched.
                    vec2 rugUV = (vWorld.xz + uRugHalf) / uRugSize;
                    float sandy = smoothstep(0.30, 0.42, dot(alb, vec3(0.2126, 0.7152, 0.0722)));
                    float upw = smoothstep(0.35, 0.7, N.y) * sandy;
                    if(upw > 0.003){
                        vec3 rn = texture2D(uRugNrm, rugUV).xyz * 2.0 - 1.0;
                        vec2 grad = -N.xz / max(N.y, 0.25);
                        grad += -rn.xz / max(rn.y, 0.2) * (1.6 * upw);
                        N = normalize(vec3(-grad.x, 1.0, -grad.y));
                    }
                    if(sandy > 0.003){
                        // The staining exists to kill the FENCE SEAM — beyond ~2 rug tiles out it
                        // buys nothing, and at the grazing angles the flat dune sea is seen from,
                        // mirror-tiled wash lanes foreshorten into hard horizon-parallel bands
                        // (they read as shorelines). Fade all albedo-side staining out past the
                        // fence zone; the residual NORMALS stay — relief reads as texture, not
                        // stripes.
                        float rugFade = 1.0 - smoothstep(360.0, 560.0, length(vWorld.xz));
                        vec3 mac = dl_toLinear(texture2D(uRugAlb, rugUV).rgb);
                        float macL = max(dot(mac, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
                        float det = clamp(macL / max(uRugMeanL, 1e-4), 0.35, 2.0);
                        vec3 macCh = mac / macL;
                        float chD = length(macCh - vec3(1.0));
                        // Chroma adoption + taming matched to gradeGround's Dark Alien values
                        // (RUG_HUE 0.55, tame 1.6) so near and far stay one map.
                        vec3 hue = mix(vec3(1.0), macCh, 0.55 / (1.0 + chD * chD * 1.6));
                        float wash = smoothstep(0.25, 0.75, texture2D(uRugCtrl, rugUV).r);
                        ${this.rugged.ero ? /* glsl */`
                        // Erosion-regime sheet, as on the near ground: silt floors lighten the
                        // wash lanes instead of darkening them.
                        vec3 ev = texture2D(uRugEro, rugUV).rgb;
                        wash *= 1.0 - ev.g * 0.55;
                        ` : ''}
                        alb *= mix(vec3(1.0), hue * det, sandy * 0.9 * rugFade);
                        alb *= mix(1.0, 0.70, wash * 0.5 * sandy * rugFade);
                        ${this.rugged.ero ? /* glsl */`
                        // Surface-age luma/hue matched to gradeGround's RUG_ERO block at reduced
                        // strength — the haze owns most far contrast; this only kills the seam.
                        // +0.137 = the same bake-measured zero-mean recentring as the near ground
                        // (channel means 0.203/0.080/0.373 at this block's 0.75 varnish weight).
                        float varnF = ev.b * 0.75;
                        float eLumF = ev.g * 0.85 + ev.r * 0.30 - varnF * 0.95 + 0.137;
                        alb *= clamp(1.0 + eLumF * 0.33 * sandy * rugFade, 0.76, 1.24);
                        alb *= mix(vec3(1.0), vec3(0.93, 0.905, 0.88), clamp(varnF * 1.15, 0.0, 1.0) * 0.5 * sandy * rugFade);
                        ` : ''}
                    }
                    ` : ''}

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

                    vec3 col = alb * (uSunCol * diff * 1.25 + amb * 0.5);

                    // Backlit rim. With the sun behind the fortress this is what draws the molten
                    // edge along its towers and turns a grey mass into a silhouette. GATED OFF
                    // up-facing ground: on the rolling dune floor seen at a grazing sunward angle
                    // the fresnel term banded every ripple crest into hard gold stripes that read
                    // as sheets of water (isolated by hiding FarWorld — the near fog was clean).
                    // A rim is a SILHOUETTE cue; flat floor has no silhouette to draw.
                    float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.5);
                    rim *= 1.0 - smoothstep(0.55, 0.80, N.y) * 0.85;
                    col += uSunCol * rim * clamp(dot(L, -V) * 0.5 + 0.5, 0.0, 1.0) * 0.55;

                    ${this.rugged ? /* glsl */`
                    // DARK-RED re-grade, matched to the near ground (gradeGround: GROUND_DARK 0.22 /
                    // GROUND_BASE_TINT (1,0.16,0.10)) so the far dune sea doesn't stay ochre against
                    // the dark near ground — KEEP THE HUE IN SYNC with that block. Gated to the dune
                    // SAND by 'sandy' so the cool alien spires, fortress and rock ridges keep their
                    // own look. col is display-space here (raw shader, no ACES), so this is a direct
                    // value-crush + deep-red tint; slightly less crush than near (0.26 vs 0.22) since
                    // the far sea is read through haze. Far erosion is haze-owned, so no streak lift —
                    // matching the base hue is what kills the near/far seam.
                    {
                        vec3 fLuma = vec3(0.2126, 0.7152, 0.0722);
                        float sLum = max(dot(col, fLuma), 1e-4);
                        vec3 sTint = vec3(1.0, 0.16, 0.10);
                        sTint /= max(dot(sTint, fLuma), 1e-4);
                        col = mix(col, sTint * (sLum * 0.26), sandy);
                    }
                    ` : ''}

                    // Atmospheric perspective, blending into the sky in THIS view direction
                    // rather than into a single flat fog colour. ALTITUDE-DEPENDENT, per the
                    // alien-vista reference: cold mist pools low — the far dune sea and the
                    // spire feet drown in it — while crowns punch through into clearer air.
                    // The factor scales the optical depth, so the fade stays exponential and
                    // seam-free across a tower's height.
                    float lowAlt = smoothstep(95.0, 6.0, vWorld.y);
                    // The same wind-drifted bank field the near fog runs (constants must match —
                    // see bankGLSL): far haze thickens and thins in the same moving weather, so
                    // the near/far handoff never draws a modulation seam.
                    ${bankGLSL}
                    float bmod = 1.0 + (bank * 2.0 - 1.0) * (0.20 + 0.33 * lowAlt);
                    float h = 1.0 - exp(-pow(dist * bmod * uHaze * mix(0.55, 1.45, lowAlt), 2.0));
                    // The pooled mist is COOLER than the dusk sky behind it — pale steel against
                    // amber. That temperature split is what reads as depth in the reference.
                    vec3 sky = dl_skyColor(-V, L);
                    vec3 fadeCol = mix(sky, uMistCol, lowAlt * 0.55);
                    col = mix(col, fadeCol, clamp(h, 0.0, 1.0));

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

        // The SAME rugged erosion field the playable terrain composites (mirror-tiled past the
        // world square), scaled up with distance like the dunes themselves. This is what makes
        // the fence line stop reading as the border between a detailed map and a smooth one.
        // Zero inside the pad (blend ramps it in), zero when the bake is absent.
        const rug = RugDetailTiled(PLAY_CENTER.x + dx, PLAY_CENTER.y + dz)
            * (3.5 + Math.min(radius / 300, 2) * 2.5)

        return DEPOT_PAD + blend * (h + rug + 9 * blend)
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
    // Alien rock spires — the vista reference's hero feature: colossal fluted towers standing
    // out of the pooled mist, dark steel-blue against the dusk with a molten rim where the sun
    // grazes them (the material's existing backlit-rim term supplies that for free).
    //
    // Placement rules: every cluster sits ≥1000 m out (far past KEEP_CLEAR), and the sun/castle
    // bearing (azimuth -118° ±22°) stays EMPTY — the fortress owns that silhouette and the
    // opening vista cone must never be contested (JourneyWorld carves terrain for that shot).
    // ---------------------------------------------------------------------------------------
    _buildSpires(){
        const rng = makeRng(4242)
        const parts = []
        const cx = PLAY_CENTER.x, cz = PLAY_CENTER.y
        // az: world compass degrees, same convention as DesertLook.SUN_AZIMUTH (-118°).
        const CLUSTERS = [
            { az: -84,  dist: 1150, n: 4, h: 300 },   // hero cluster right of the sunset — under the moons
            { az: -150, dist: 1250, n: 3, h: 250 },   // left flank, under the stray moon
            { az: -48,  dist: 1500, n: 2, h: 210 },
            { az: 22,   dist: 1250, n: 3, h: 270 },   // the skyline at the player's back
            { az: 95,   dist: 1450, n: 2, h: 220 },
            { az: 165,  dist: 1600, n: 3, h: 290 },
        ]
        for(const cl of CLUSTERS){
            const baseAng = cl.az * Math.PI / 180
            for(let i = 0; i < cl.n; i++){
                const ang = baseAng + (rng() - 0.5) * 0.16
                const dist = cl.dist * (0.86 + rng() * 0.30)
                const x = cx + Math.cos(ang) * dist
                const z = cz + Math.sin(ang) * dist
                // First of each cluster is the monarch; companions step well down, as in the ref.
                const height = cl.h * (i === 0 ? 0.9 + rng() * 0.25 : 0.42 + rng() * 0.38)
                const baseR = height * (0.10 + rng() * 0.05)
                parts.push(this._spireGeometry(baseR, height, rng, x, z, dist))
            }
        }
        this._adopt(BufferGeometryUtils.mergeBufferGeometries(parts), 'FarSpires')
    }

    // One spire: a lofted fluted column — stepped strata (radius holds through a band, then
    // jumps in), a lobed cross-section so the silhouette reads as wind-carved rock rather than
    // a cone, a slight whole-tower lean, and a talus skirt that beds it into the dune sea. The
    // skirt's vertex colour walks toward sand, so the shared rugged albedo picks it up and the
    // foot belongs to the ground it stands on. ~700 triangles; merged with its siblings.
    _spireGeometry(baseR, height, rng, x, z, dist){
        const SIDES = 10, RINGS = 11
        const positions = [], colors = [], indices = []
        // Cool alien rock — deliberately colder than PALETTE.stoneDark's warm brown. Kept dark:
        // vertex-colour luminance below the far shader's "sandy" gate, so the erosion albedo
        // never restains the towers.
        const rock = new THREE.Color(0x39414f)
        const rockLo = new THREE.Color(0x252b36)
        const sandFoot = PALETTE.sandDark.clone().lerp(rockLo, 0.45)
        const y0 = this._duneHeight(x - PLAY_CENTER.x, z - PLAY_CENTER.y, dist) - (8 + baseR * 0.35)
        const fluteN = 3 + Math.floor(rng() * 3)
        const flutePhase = rng() * Math.PI * 2
        const lean = (rng() - 0.5) * 0.07
        const leanDir = rng() * Math.PI * 2

        // Ring ladder: [0] talus skirt hem, [1] foot, [2..] the tower, stepped.
        let stepR = 1.0
        const rings = []
        rings.push({ y: y0 - baseR * 0.9, rad: baseR * 3.0, col: sandFoot, spread: 0.10 })
        rings.push({ y: y0, rad: baseR * 1.06, col: rockLo.clone().lerp(rock, 0.3), spread: 0.16 })
        for(let r = 0; r <= RINGS; r++){
            const t = r / RINGS
            // Gentle taper + small strata steps: the reference towers are COLUMNAR — near-straight
            // shafts with blunt broken tops. The first cut (t*0.52, steps to ~0.5) read as witch
            // hats on the horizon.
            if(r > 0 && rng() < 0.55){ stepR *= 0.88 + rng() * 0.09 }
            const band = rockLo.clone().lerp(rock, 0.35 + rng() * 0.65)
            rings.push({
                y: y0 + height * Math.pow(t, 0.92),
                rad: baseR * (1.0 - t * 0.30) * stepR,
                col: band, spread: 0.22,
            })
        }
        for(const ring of rings){
            const yy = ring.y
            const lx = Math.cos(leanDir) * lean * Math.max(0, yy - y0)
            const lz = Math.sin(leanDir) * lean * Math.max(0, yy - y0)
            for(let s = 0; s <= SIDES; s++){
                const a = (s / SIDES) * Math.PI * 2
                const flute = 1 + 0.14 * Math.sin(a * fluteN + flutePhase)
                    + 0.09 * Math.sin(a * (fluteN * 2 + 1) - flutePhase * 1.7)
                const rad = ring.rad * flute
                positions.push(x + lx + Math.cos(a) * rad, yy, z + lz + Math.sin(a) * rad)
                const f = 1 + (rng() - 0.5) * ring.spread
                colors.push(ring.col.r * f, ring.col.g * f, ring.col.b * f)
            }
        }
        const stride = SIDES + 1
        for(let r = 0; r < rings.length - 1; r++){
            for(let s = 0; s < SIDES; s++){
                const a = r * stride + s, b = a + 1, c = a + stride, d = c + 1
                indices.push(a, c, b, b, c, d)
            }
        }
        // Broken crown: a jittered near-FLAT apex fan over the last ring, off-centre — a blunt
        // sheared top, not a steeple (see the taper note above).
        const top = rings[rings.length - 1]
        const apex = positions.length / 3
        positions.push(
            x + Math.cos(leanDir) * lean * height + (rng() - 0.5) * top.rad,
            top.y + baseR * (0.06 + rng() * 0.12),
            z + Math.sin(leanDir) * lean * height + (rng() - 0.5) * top.rad)
        colors.push(rock.r * 1.25, rock.g * 1.25, rock.b * 1.25)
        const lastRow = (rings.length - 1) * stride
        for(let s = 0; s < SIDES; s++){ indices.push(lastRow + s, apex, lastRow + s + 1) }

        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
        g.setIndex(indices)
        g.computeVertexNormals()
        return g
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

    Update(t){
        // Only the haze-bank clock — the far world itself never moves.
        if(this.material){ this.material.uniforms.uTime.value += t }
    }

    Dispose(){
        for(const m of this.pieces){ m.geometry.dispose() }
        if(this.material){ this.material.dispose() }
        this.scene.remove(this.root)
    }
}
