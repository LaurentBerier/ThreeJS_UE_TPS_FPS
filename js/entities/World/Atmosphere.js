import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, GLSL_NOISE, GLSL_ENCODE, sunDirection, windDirection, windStrengthAt, WIND_SPEED, PLAY_CENTER } from './DesertLook.js'
import { SMOKES } from './JourneyWorld.js'


// Air: drifting sand at ground level, dust plumes on the horizon, and shafts of light breaking
// through the cloud deck.
//
// READABILITY IS THE CONSTRAINT, not the look. The brief is explicit that none of this may obscure
// enemies, projectiles, crosshairs or attack telegraphs, and atmosphere is exactly the kind of
// effect that quietly ruins a shooter. Three rules fall out of that, and every effect here obeys
// them:
//
//   1. NOTHING DRAWS NEAR THE CAMERA. The sand motes fade to zero inside 2.5 m, so nothing ever
//      sits on the lens or drifts across the crosshair. This is the important one — a particle at
//      1 m covers more screen than an enemy at 30 m.
//   2. NOTHING DRAWS AT COMBAT DEPTH. The plumes and shafts live 300 m+ out, past everything the
//      player can shoot, so they can only ever appear behind the fight.
//   3. EVERYTHING IS ADDITIVE AND FAINT. Additive blending can only lighten, so no effect here can
//      ever hide a dark silhouette against the sand — the single most important read in the level.
//
// All of it is GPU-animated from one uTime uniform: no per-particle CPU work, no allocation, and
// no per-frame cost beyond three draw calls.
const MOTE_COUNT = 900
const MOTE_BOX = 70          // motes live in a box this wide that follows the camera


export default class Atmosphere extends Component{
    constructor(scene, camera){
        super()
        this.name = 'Atmosphere'
        this.scene = scene
        this.camera = camera
        this.sunDir = sunDirection()
        this.time = 0
        this.parts = []
    }

    Initialize(){
        this.terrain = this.FindEntity('Level') ? this.FindEntity('Level').GetComponent('Terrain') : null
        this._buildMotes()
        this._buildStreaks()
        this._buildPlumes()
        this._buildShafts()
        this._buildSmokes()
    }

    // --- Ground-level drifting sand -----------------------------------------------------------
    // A fixed cloud of points that RIDES the camera, wrapping each mote modulo the box size in the
    // vertex shader. That makes a small fixed buffer look like an endless field of blowing sand,
    // and it means the effect costs the same wherever the player stands.
    _buildMotes(){
        const positions = new Float32Array(MOTE_COUNT * 3)
        const seeds = new Float32Array(MOTE_COUNT)
        for(let i = 0; i < MOTE_COUNT; i++){
            positions[i * 3] = Math.random() * MOTE_BOX
            // Biased low: blowing sand hugs the ground, and keeping it out of eye-line is also
            // what keeps it away from the crosshair.
            positions[i * 3 + 1] = Math.pow(Math.random(), 2.1) * 7.0
            positions[i * 3 + 2] = Math.random() * MOTE_BOX
            seeds[i] = Math.random()
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        g.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uCam: { value: new THREE.Vector3() },
                uBox: { value: MOTE_BOX },
                uCol: { value: new THREE.Vector3(PALETTE.dust.r, PALETTE.dust.g, PALETTE.dust.b) },
                // THE world wind (DesertLook) — the same direction the flags, smoke, clouds and
                // sand ripples answer to.
                uWind: { value: new THREE.Vector2(windDirection().x * WIND_SPEED, windDirection().z * WIND_SPEED) },
            },
            vertexShader: /* glsl */`
                attribute float seed;
                uniform float uTime;
                uniform vec3 uCam;
                uniform float uBox;
                uniform vec2 uWind;
                varying float vFade;
                void main(){
                    vec3 p = position;
                    // Wind drift along the shared world wind (each mote at its own fraction of the
                    // wind speed — near-ground air is slower), with a slow vertical wander so it
                    // does not read as a conveyor.
                    p.xz += uTime * uWind * (0.30 + seed * 0.45);
                    p.y += sin(uTime * (0.4 + seed) + seed * 31.0) * 0.5;
                    // Wrap into a box centred on the camera: an endless field from a small buffer.
                    vec3 origin = uCam - vec3(uBox * 0.5, 2.0, uBox * 0.5);
                    p = origin + mod(p - origin, vec3(uBox, 9.0, uBox));

                    vec4 mv = modelViewMatrix * vec4(p, 1.0);
                    float dist = -mv.z;
                    // Rule 1: nothing near the lens. Fades in from 2.5 m and out again by 55 m.
                    vFade = smoothstep(2.5, 9.0, dist) * (1.0 - smoothstep(30.0, 55.0, dist));
                    gl_PointSize = (14.0 / max(dist, 1.0)) * (0.5 + seed);
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uCol;
                varying float vFade;
                ${GLSL_ENCODE}
                void main(){
                    // Soft round mote; discard the corners so points do not read as squares.
                    vec2 d = gl_PointCoord - 0.5;
                    float r = dot(d, d);
                    if(r > 0.25){ discard; }
                    float a = (1.0 - r * 4.0) * vFade * 0.17;
                    gl_FragColor = vec4(dl_toLinear(uCol), a);
                }
            `,
        })

        const pts = new THREE.Points(g, mat)
        pts.frustumCulled = false        // it follows the camera; culling it would flicker
        pts.userData.noExport = true
        this.motes = pts
        this.moteMat = mat
        this.scene.add(pts)
        this.parts.push(pts)
    }

    // --- Wind streaks ---------------------------------------------------------------------------
    // The VISIBLE wind: thin line streaks riding the citadel wind in gusty bursts — the classic
    // stylised air-current read. Same architecture as the motes (a fixed buffer wrapped modulo a
    // camera-following box, all animation from uTime on the GPU), but drawn as LINE SEGMENTS:
    // the head vertex is the air parcel, the tail trails upwind, so every streak is a visible
    // arrow of where the wind is going. Readability rules hold: nothing inside 3.5 m, 1-pixel
    // additive lines that brighten in gust waves and die between them, so they read as weather,
    // not as a constant particle rain.
    _buildStreaks(){
        const COUNT = 240
        const positions = new Float32Array(COUNT * 2 * 3)
        const seeds = new Float32Array(COUNT * 2)
        const ends = new Float32Array(COUNT * 2)
        for(let i = 0; i < COUNT; i++){
            const x = Math.random() * MOTE_BOX
            // Height bias: wind streaks live in the walked layer of air — mostly 0.5–3 m with a
            // tail up to ~7 m, so they cross the frame without living on the crosshair line.
            const y = 0.4 + Math.pow(Math.random(), 1.8) * 6.5
            const z = Math.random() * MOTE_BOX
            const s = Math.random()
            for(let k = 0; k < 2; k++){
                const o = (i * 2 + k)
                positions[o * 3] = x; positions[o * 3 + 1] = y; positions[o * 3 + 2] = z
                seeds[o] = s
                ends[o] = k
            }
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        g.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
        g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1))

        const wd = windDirection()
        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uCam: { value: new THREE.Vector3() },
                uBox: { value: MOTE_BOX },
                uGust: { value: 0.5 },       // normalised gust envelope, fed from windStrengthAt
                uWind: { value: new THREE.Vector3(wd.x, 0, wd.z) },
                uCol: { value: new THREE.Vector3(
                    PALETTE.dust.r * 0.7 + 0.3, PALETTE.dust.g * 0.7 + 0.3, PALETTE.dust.b * 0.7 + 0.3) },
            },
            vertexShader: /* glsl */`
                attribute float seed;
                attribute float aEnd;
                uniform float uTime;
                uniform vec3 uCam;
                uniform float uBox;
                uniform float uGust;
                uniform vec3 uWind;
                varying float vA;
                varying float vEnd;
                void main(){
                    vec3 p = position;
                    // Streaks ride FASTER than the motes — they are the visible fast layer of the
                    // same air. Each at its own fraction so the field never marches in step.
                    float speed = ${WIND_SPEED.toFixed(2)} * (0.7 + seed * 0.6);
                    p.xz += uTime * uWind.xz * speed;
                    // Wrap the HEAD into the camera box; the tail hangs off the same wrapped
                    // head, so a segment can never straddle the wrap seam.
                    vec3 origin = uCam - vec3(uBox * 0.5, 2.0, uBox * 0.5);
                    p = origin + mod(p - origin, vec3(uBox, 8.0, uBox));
                    // Gust waves: each streak flares in its own phase, cubed so the field is
                    // mostly OFF and arrives in visible pulses that cross the screen together.
                    float burst = pow(0.5 + 0.5 * sin(uTime * (0.55 + seed * 0.75) + seed * 41.0), 3.0);
                    // Trail upwind. Length breathes with the gust envelope — hard wind draws
                    // long slashes, the lulls shrink them to ticks.
                    float len = (0.9 + seed * 1.6) * (0.35 + uGust * 1.35) * (0.4 + burst * 0.8);
                    vec3 tail = -uWind * len;
                    // A light vertical S-bend on the tail so streaks read as flowing air, not
                    // ruled pencil lines.
                    float bob = sin(uTime * (1.6 + seed) + seed * 31.0);
                    p.y += bob * 0.25;
                    p += aEnd * (tail + vec3(0.0, sin(uTime * 1.8 + seed * 17.0) * 0.22, 0.0));

                    vec4 mv = modelViewMatrix * vec4(p, 1.0);
                    float dist = -mv.z;
                    // Rule 1: nothing near the lens; long fade-out keeps the mid-field alive.
                    float fade = smoothstep(3.5, 8.0, dist) * (1.0 - smoothstep(30.0, 52.0, dist));
                    vA = fade * (0.12 + 0.88 * burst) * (0.35 + uGust * 0.65);
                    vEnd = aEnd;
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uCol;
                varying float vA;
                varying float vEnd;
                ${GLSL_ENCODE}
                void main(){
                    // Taper toward the tail: the bright head + fading trail is what makes the
                    // motion direction legible in a still frame.
                    float a = vA * (1.0 - vEnd * 0.75) * 0.30;
                    gl_FragColor = vec4(dl_toLinear(uCol), a);
                }
            `,
        })

        const lines = new THREE.LineSegments(g, mat)
        lines.frustumCulled = false      // camera-following field, same as the motes
        lines.userData.noExport = true
        this.streaks = lines
        this.streakMat = mat
        this.scene.add(lines)
        this.parts.push(lines)
    }

    // --- Distant dust plumes ------------------------------------------------------------------
    // Big soft billboards standing on the horizon: wind lifting sand off far dunes. Rule 2 —
    // they sit 300 m+ out, so they are always behind anything the player can interact with.
    _buildPlumes(){
        const COUNT = 9
        const g = new THREE.PlaneGeometry(1, 1)
        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uCol: { value: new THREE.Vector3(PALETTE.haze.r, PALETTE.haze.g, PALETTE.haze.b) },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main(){
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform float uTime;
                uniform vec3 uCol;
                varying vec2 vUv;
                ${GLSL_NOISE}
                ${GLSL_ENCODE}
                void main(){
                    vec2 uv = vUv;
                    // A billowing column: noise that rises and spreads with height.
                    float rise = uv.y;
                    float n = dl_fbm(vec3(uv.x * 4.0, uv.y * 2.0 - uTime * 0.05, 0.0));
                    float body = smoothstep(0.55, 0.15, abs(uv.x - 0.5) * (2.4 - rise * 1.2));
                    float a = body * n * (1.0 - rise) * smoothstep(0.0, 0.25, rise);
                    gl_FragColor = vec4(dl_toLinear(uCol), a * 0.27);
                }
            `,
        })

        const rng = (() => { let s = 24680; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } })()
        for(let i = 0; i < COUNT; i++){
            const ang = (i / COUNT) * Math.PI * 2 + rng() * 0.5
            // Beyond the playable square's corners (453 m), so a plume can never stand at combat
            // depth anywhere along the journey.
            const dist = 640 + rng() * 420
            const w = 90 + rng() * 160
            const h = 45 + rng() * 90
            const m = new THREE.Mesh(g, mat)
            m.scale.set(w, h, 1)
            m.position.set(
                PLAY_CENTER.x + Math.cos(ang) * dist,
                h * 0.4,
                PLAY_CENTER.y + Math.sin(ang) * dist,
            )
            m.lookAt(PLAY_CENTER.x, h * 0.4, PLAY_CENTER.y)
            m.userData.noExport = true
            m.renderOrder = 5
            this.scene.add(m)
            this.parts.push(m)
        }
        this.plumeMat = mat
    }

    // --- Light shafts ---------------------------------------------------------------------------
    // Wedges of light fanning down from the break in the cloud deck. Placed far out in the sky
    // along the sun's bearing, so they read as god rays behind the level and can never wash across
    // the playfield. Additive and faint (rule 3).
    _buildShafts(){
        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: false,          // sky furniture — always behind, never occluding
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uCol: { value: new THREE.Vector3(PALETTE.sun.r, PALETTE.sun.g, PALETTE.sun.b) },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main(){
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform float uTime;
                uniform vec3 uCol;
                ${GLSL_ENCODE}
                varying vec2 vUv;
                void main(){
                    // Bright at the top (the gap in the cloud), fading downward and at the edges.
                    float down = 1.0 - vUv.y;
                    float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
                    float breathe = 0.75 + 0.25 * sin(uTime * 0.13 + vUv.x * 3.0);
                    // Raised 0.16 -> 0.22 for the cinematic re-grade: the god rays fanning off the
                    // sun were barely legible; this makes the shafted light read as real air behind
                    // the vista. Still additive + faint + 700 m out, so combat is untouched.
                    float a = edge * pow(vUv.y, 1.6) * 0.22 * breathe;
                    gl_FragColor = vec4(dl_toLinear(uCol), a);
                }
            `,
        })

        const group = new THREE.Group()
        const sunAng = Math.atan2(this.sunDir.z, this.sunDir.x)
        // 7 shafts (was 5), fanned a little wider so the shafted light owns more of the sky's
        // sun-quadrant — the extra atmosphere the cinematic re-grade asks for.
        const SHAFTS = 7
        for(let i = 0; i < SHAFTS; i++){
            const g = new THREE.PlaneGeometry(1, 1)
            const m = new THREE.Mesh(g, mat)
            const spread = (i - (SHAFTS - 1) / 2) * 0.135
            const dist = 700
            const w = 80 + i * 18
            const h = 320
            m.scale.set(w, h, 1)
            const a = sunAng + spread
            m.position.set(
                PLAY_CENTER.x + Math.cos(a) * dist,
                h * 0.42,
                PLAY_CENTER.y + Math.sin(a) * dist,
            )
            m.lookAt(PLAY_CENTER.x, h * 0.42, PLAY_CENTER.y)
            m.rotateZ((i - (SHAFTS - 1) / 2) * 0.045)
            m.userData.noExport = true
            m.renderOrder = -900       // between the sky dome and the cloud deck
            group.add(m)
        }
        group.userData.noExport = true
        this.scene.add(group)
        this.parts.push(group)
        this.shaftMat = mat
    }

    // --- Machinery smoke -------------------------------------------------------------------------
    // Thin dark columns rising off the dead hulks and the gate brazier (positions authored in
    // JourneyWorld.SMOKES, all at arena EDGES off the fight lanes). The one deliberate exception
    // to this module's additive-only rule: smoke must DARKEN to read as smoke. Mitigations so it
    // can never cost combat readability: columns are narrow, capped at ~30% opacity, placed off
    // every walk line, and fade out entirely within 12 m of the camera.
    _buildSmokes(){
        const g = new THREE.PlaneGeometry(1, 1)
        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending,
            side: THREE.DoubleSide,
            fog: false,
            uniforms: { uTime: { value: 0 } },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                varying float vCam;
                void main(){
                    vUv = uv;
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    vCam = -mv.z;
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: /* glsl */`
                uniform float uTime;
                varying vec2 vUv;
                varying float vCam;
                ${GLSL_NOISE}
                ${GLSL_ENCODE}
                void main(){
                    // A leaning, curling column: fbm scrolled upward, pinched at the base.
                    vec2 uv = vUv;
                    uv.x += (uv.y * uv.y) * 0.22;                       // wind lean
                    float n = dl_fbm(vec3(uv.x * 5.0, uv.y * 3.0 - uTime * 0.14, 1.0));
                    float core = smoothstep(0.42, 0.1, abs(uv.x - 0.5) * (1.6 + uv.y * 2.4));
                    float a = core * n * smoothstep(0.0, 0.15, uv.y) * (1.0 - smoothstep(0.55, 1.0, uv.y));
                    a *= 0.30 * smoothstep(4.0, 12.0, vCam);            // never smears the lens
                    vec3 col = vec3(0.055, 0.05, 0.048);                // sooty brown-black
                    gl_FragColor = vec4(dl_toLinear(col), a);
                }
            `,
        })
        for(const s of SMOKES){
            const ground = this.terrain ? this.terrain.HeightAt(s.x, s.z) : 0
            const h = 16 * (s.s || 1), w = 5.5 * (s.s || 1)
            const m = new THREE.Mesh(g, mat)
            m.scale.set(w, h, 1)
            m.position.set(s.x, ground + h * 0.42, s.z)
            m.userData.noExport = true
            m.renderOrder = 6
            this.scene.add(m)
            this.parts.push(m)
            // Cross-plane so the column reads from every bearing.
            const m2 = m.clone()
            m2.rotation.y = Math.PI / 2
            this.scene.add(m2)
            this.parts.push(m2)
        }
        this.smokeMat = mat
    }

    Update(t){
        this.time += t
        if(this.moteMat){
            this.moteMat.uniforms.uTime.value = this.time
            this.moteMat.uniforms.uCam.value.copy(this.camera.position)
        }
        if(this.streakMat){
            this.streakMat.uniforms.uTime.value = this.time
            this.streakMat.uniforms.uCam.value.copy(this.camera.position)
            // Normalised gust envelope (windStrengthAt spans ~0.32..1.12 of WIND_SPEED) — the
            // whole streak field breathes with the same gusts the cloth answers to.
            const g = (windStrengthAt(this.time) / WIND_SPEED - 0.32) / 0.80
            this.streakMat.uniforms.uGust.value = THREE.MathUtils.clamp(g, 0, 1)
        }
        if(this.plumeMat){ this.plumeMat.uniforms.uTime.value = this.time }
        if(this.shaftMat){ this.shaftMat.uniforms.uTime.value = this.time }
        if(this.smokeMat){ this.smokeMat.uniforms.uTime.value = this.time }
    }

    Dispose(){
        for(const p of this.parts){ this.scene.remove(p) }
    }
}
