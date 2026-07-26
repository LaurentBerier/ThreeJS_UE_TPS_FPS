import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, GLSL_NOISE, GLSL_SKY, GLSL_ENCODE, sunDirection, setFogTime, PLAY_CENTER } from './DesertLook.js'


// Golden-hour desert sky + the whole light rig + atmospheric fog.
//
// Replaces the template's bright-day photo dome (Sky2) and its white hemisphere light. Three
// things live here because they are one artistic decision and drift apart if separated:
//
//   * the SKY, a procedural dusk gradient with a low sun burning through horizon dust;
//   * the LIGHT RIG that must agree with it (a warm raking key from the sun's exact direction,
//     a cool sky/warm sand-bounce hemisphere, and a cold counter-fill for shape in shadow);
//   * the FOG, whose colour has to match the sky's horizon or the world ends at a visible seam.
//
// The key light is not a new light. LevelSetup already configures the shadow-casting directional
// light that ships inside level.glb; this re-aims and re-grades that same light, so the existing
// shadow setup, its 2048² map and the export path all stay exactly as they were.

export default class DesertSky extends Component{
    constructor(scene, camera){
        super()
        this.name = 'DesertSky'
        this.scene = scene
        this.camera = camera
        this.sunDir = sunDirection()
        this.time = 0
    }

    Initialize(){
        this.BuildDome()
        this.BuildLights()
        this.BuildFog()
    }

    // NOTE on ambient reflection. The obvious move here is a PMREM probe of the dome fed into
    // scene.environment. It does not work on the pinned three r127: PMREMGenerator hands back a
    // HalfFloatType target tagged RGBEEncoding, so the material shader decodes it as RGBE
    // (rgb * exp2(a*255 - 128)), the values overflow to Inf, and every surface carrying the
    // environment renders NaN — which the GPU draws as solid black. It fails silently, with no
    // shader error to go on.
    //
    // scene.environment IS now populated — by HdrEnvironment.js, which sidesteps PMREM entirely
    // (plain mipmapped cube render target + a CPU-projected SH light probe from the .hdr). The
    // light grades below are balanced AGAINST that probe: the hemisphere/fill no longer carry the
    // whole ambient floor by themselves, they top up what the HDR's irradiance already provides.
    // DesertLook's analytic dl_skyColor() fresnel reflection in gradeStructure still applies on
    // top — it tracks the procedural dome exactly and costs no texture sample.

    BuildDome(){
        // The moon cluster — the alien-vista reference's signature. Angles are world compass
        // bearings (same convention as SUN_AZIMUTH); the journey looks toward azimuth ≈ -120°,
        // so the cluster hangs just right of the castle's silhouette with one stray low on the
        // left flank. Radii are angular degrees — 5–10× a terrestrial moon, deliberately.
        // DOME-ONLY, like the sun disc: dl_skyColor stays moon-free so reflections and the
        // distance-haze fades never pick one up (a ridge dissolving into a moon reads as a bug).
        const MOONS = [
            { az: -100, elev: 26, radius: 2.4, seed: 3.0, bright: 1.0 },   // the big one
            { az: -88,  elev: 21, radius: 1.5, seed: 7.0, bright: 0.9 },   // companion, lower right
            { az: -108, elev: 34, radius: 0.95, seed: 11.0, bright: 0.8 }, // high stray
            { az: -152, elev: 19, radius: 0.7, seed: 17.0, bright: 0.65 }, // dim one off the left flank
        ]
        const moonCalls = MOONS.map((m) => {
            const az = THREE.MathUtils.degToRad(m.az), el = THREE.MathUtils.degToRad(m.elev)
            const d = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el))
            return `mcol += dl_moonShade(dir, sun, vec3(${d.x.toFixed(5)}, ${d.y.toFixed(5)}, ${d.z.toFixed(5)}), ` +
                `${THREE.MathUtils.degToRad(m.radius).toFixed(5)}, ${m.seed.toFixed(1)}, ${m.bright.toFixed(2)}, mcover);`
        }).join('\n                    ')
        const cc = (col) => `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})`

        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,                 // the dome IS the fog colour's source — fogging it is circular
            uniforms: {
                uSunDir: { value: this.sunDir.clone() },
            },
            vertexShader: /* glsl */`
                varying vec3 vDir;
                void main(){
                    vDir = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uSunDir;
                varying vec3 vDir;
                ${GLSL_NOISE}
                ${GLSL_SKY}
                ${GLSL_ENCODE}

                // Starfield. Cell-point stars on the direction sphere: one candidate per cell,
                // pulled toward the cell centre so no star is ever clipped by its cell wall.
                // Gated by altitude (the horizon dust drowns them) and away from the sunset
                // quadrant (a star inside the glow reads as noise, not night).
                vec3 dl_stars(vec3 dir, vec3 sunDir){
                    vec3 p = dir * 56.0;
                    vec3 cell = floor(p);
                    float h = dl_hash(cell + 0.19);
                    vec3 jit = vec3(dl_hash(cell + 0.31), dl_hash(cell + 0.73), dl_hash(cell + 1.71));
                    vec3 sp = cell + 0.5 + (jit - 0.5) * 0.6;
                    float d = length(p - sp);
                    float star = smoothstep(0.16, 0.03, d);
                    // Magnitude distribution: most cells empty, a few bright — squared so the
                    // handful of hero stars stand well proud of the dust of faint ones.
                    float mag = smoothstep(0.72, 1.0, h);
                    mag *= mag;
                    float warmside = pow(clamp(dot(dir, sunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
                    float vis = smoothstep(0.08, 0.50, dir.y) * (1.0 - warmside * 0.92);
                    vec3 tint = mix(vec3(1.0, 0.93, 0.84), vec3(0.80, 0.89, 1.0), dl_hash(cell + 2.9));
                    return tint * (star * mag * vis * 1.1);
                }

                // One moon: an actual sphere, phase-shaded by the REAL sun direction — so every
                // moon hangs lit-side-down toward the sunset and the sky stays one light. fbm
                // maria + ridged craters on the sphere normal give the face; a soft cold halo
                // seats it in the haze. The cover out-param reports disc opacity so the caller
                // can REPLACE the sky behind it (a moon is rock, not an additive glow).
                vec3 dl_moonShade(vec3 dir, vec3 sunDir, vec3 mdir, float ang, float seed, float bright, inout float cover){
                    float cd = clamp(dot(dir, mdir), -1.0, 1.0);
                    float a = acos(cd);
                    vec3 col = vec3(0.0);
                    if(a < ang){
                        vec3 u = normalize(cross(mdir, vec3(0.0, 1.0, 0.0)));
                        vec3 v = cross(u, mdir);
                        vec2 off = vec2(dot(dir, u), dot(dir, v)) / sin(ang);
                        float r2 = min(dot(off, off), 1.0);
                        float w = sqrt(1.0 - r2);
                        vec3 n = normalize(u * off.x + v * off.y - mdir * w);
                        float ndl = clamp(dot(n, sunDir), 0.0, 1.0);
                        float mare = dl_fbm(n * (4.0 + seed) + seed * 7.3);
                        float crater = dl_ridge(n * (9.0 + seed * 0.7) + seed * 3.1);
                        float albedo = 0.74 + 0.18 * mare + 0.08 * crater;
                        // NOT honest lambert. This close to the sun's bearing a real moon is a
                        // hairline crescent — measured: the cluster rendered as black holes in
                        // the glow. The reference paints pale lit balls regardless, so the phase
                        // term is softened onto a high skyshine floor: the sun side still
                        // brightens, but the whole face stays luminous against the dusk.
                        vec3 lit = ${cc(PALETTE.moon)} * (albedo * (ndl * 0.50 + 0.42)) * bright;
                        float edge = smoothstep(1.0, 0.955, r2);
                        col = lit * edge;
                        cover = max(cover, edge);
                    }
                    col += ${cc(PALETTE.moon)} * exp(-a / (ang * 1.7)) * 0.05 * bright;
                    return col;
                }

                void main(){
                    vec3 dir = normalize(vDir);
                    vec3 sun = normalize(uSunDir);
                    vec3 col = dl_skyColor(dir, sun);
                    col += dl_stars(dir, sun);
                    float mcover = 0.0;
                    vec3 mcol = vec3(0.0);
                    ${moonCalls}
                    col = col * (1.0 - mcover) + mcol;
                    col += dl_sunDisc(dir, sun);
                    // Break up the gradient so the huge smooth areas do not band on 8-bit output.
                    col += (dl_hash(vec3(gl_FragCoord.xy, 0.0)) - 0.5) * 0.012;
                    gl_FragColor = vec4(dl_toLinear(col), 1.0);
                }
            `,
        })

        const dome = new THREE.Mesh(new THREE.SphereGeometry(2800, 48, 32), mat)
        dome.frustumCulled = false
        dome.renderOrder = -1000
        dome.userData.noExport = true        // skybox dressing — never part of the UE level export
        this.dome = dome
        this.scene.add(dome)
    }

    BuildLights(){
        const center = new THREE.Vector3(PLAY_CENTER.x, 0, PLAY_CENTER.y)

        // --- Key: re-grade the shadow-casting sun that ships inside level.glb. -------------------
        let sun = null
        this.scene.traverse((o) => { if(!sun && o.isDirectionalLight){ sun = o } })
        if(!sun){
            // Defensive: if the level ever ships without its light, the world still lights itself.
            sun = new THREE.DirectionalLight(0xffffff, 1)
            sun.castShadow = true
            sun.shadow.mapSize.set(2048, 2048)
            this.scene.add(sun)
        }
        sun.color.copy(PALETTE.sun)
        // The key has to DOMINATE. Golden hour is a high-contrast hour: what makes it read is the
        // ratio between a hot raking key and a dim cool ambient, not the absolute brightness. An
        // earlier balance here (sun 2.25 / ambient 1.15) sat everything in one mid-tone band and
        // the long shadows the whole look depends on simply disappeared.
        sun.intensity = 3.2
        sun.position.copy(center).addScaledVector(this.sunDir, 120)
        // Aim at the middle of the playable footprint. The stock light targets the world origin,
        // which sits off one corner of this level, so the shadow frustum was spending most of its
        // resolution on empty ground.
        sun.target.position.copy(center)
        if(!sun.target.parent){ this.scene.add(sun.target) }
        sun.target.updateMatrixWorld()

        // A sun this low throws shadows ~4x the height of what casts them, and the journey world
        // is 640 m across — no static frustum can cover it at usable resolution. So the frustum is
        // a 104 m box that FOLLOWS the camera (see Update), snapped to the shadow map's texel grid
        // so the crawl/shimmer that naive light-following causes never appears. 104 m around the
        // player covers everything whose shadow can reach them, castle towers included.
        const s = sun.shadow
        s.camera.left = -52; s.camera.right = 52
        s.camera.top = 52;   s.camera.bottom = -52
        s.camera.near = 1;   s.camera.far = 420
        // Grazing light is the worst case for shadow acne. normalBias offsets along the surface
        // normal, which fixes it without the peter-panning a large constant bias would cause.
        s.bias = -0.0004
        s.normalBias = 0.035
        s.camera.updateProjectionMatrix()
        this.sun = sun

        // Light-space basis for the follow snap: with a fixed sun direction, snapping the frustum
        // centre to whole texels in this basis keeps every shadow edge pixel-stable while the box
        // glides with the camera.
        this._lsRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.sunDir).normalize()
        this._lsUp = new THREE.Vector3().crossVectors(this.sunDir, this._lsRight).normalize()
        this._texel = (52 * 2) / 2048
        this._snapped = new THREE.Vector3()

        // --- Ambient: cool sky above, warm sand bounce below. ------------------------------------
        // This light TOPS UP the HDR light probe (HdrEnvironment) with art-directed tint control.
        // Between them they own the shadow floor: the old probe-less balance (hemi 0.34 alone)
        // crushed anything in shadow to near-black, which read as "shadows too dark" — the fix is
        // exactly this floor, not softening the key (golden hour still needs its contrast).
        const hemi = new THREE.HemisphereLight(PALETTE.skyAmbient.getHex(), PALETTE.sandBounce.getHex(), 0.46)
        hemi.position.set(0, 60, 0)
        this.scene.add(hemi)
        this.hemi = hemi

        // --- Counter-fill: a cold, shadowless light from opposite the sun. -----------------------
        // Purely for shape. Without it, every surface facing away from the sun flattens into the
        // hemisphere's single tone and characters lose their silhouette against dark containers.
        const fill = new THREE.DirectionalLight(PALETTE.shadowTint.getHex(), 0.22)
        fill.position.copy(center).addScaledVector(this.sunDir, -70).setY(38)
        fill.target.position.copy(center)
        this.scene.add(fill)
        this.scene.add(fill.target)
        this.fill = fill
    }

    BuildFog(){
        // scene.fog still carries the COLOUR + BASE DENSITY, but the fog itself is the custom
        // height/noise/sun fog DesertLook installs over three's fog chunks (see CUSTOM FOG there).
        //
        // Density is chosen against the same two fixed points as ever — plus a third, new one.
        // COMBAT: at 40 m the (density·m)² curve removes well under 1% of contrast (and the haze
        // banks are hard-gated to zero inside 55 m), so enemies and telegraphs are untouched.
        // THE LANDMARK: the castle at ~600 m now sits HIGH in a thin-air band — the height
        // falloff pays for a denser base, so the keep stays readable while the basin floors
        // below it drown at the same range. THE DEPTH: 0.0017 (up from the flat fog's 0.0011,
        // raised 0.0014 -> 0.0017 for the cinematic re-grade) is what buys the pooled-mist vista —
        // low, far ground vanishing into cold haze is the depth cue the flat fog could never
        // afford without erasing the castle too. The height falloff keeps the elevated keep clear
        // while the extra density stacks up in the basins where the aerial perspective reads.
        this.scene.fog = new THREE.FogExp2(PALETTE.haze.getHex(), 0.0017)
    }

    Update(t){
        this.time += t
        // Drive the custom fog's clock — the wind-drifted haze banks (see DesertLook's CUSTOM
        // FOG). One call fans out to every fogged material in the scene.
        setFogTime(this.time)
        // Park the dome on the camera so the horizon stays put as the player crosses the level.
        // A fixed dome parallaxes visibly even over a short walk, which reads as the sky sliding.
        if(this.dome && this.camera){ this.dome.position.copy(this.camera.position) }

        // Glide the shadow frustum with the camera (see BuildLights), quantised to shadow texels
        // in the light's own basis so edges don't shimmer as the box moves. The counter-fill
        // follows un-snapped — it casts no shadows, so there is nothing to stabilise.
        if(this.sun && this.camera){
            const c = this.camera.position
            const rx = Math.round(c.dot(this._lsRight) / this._texel) * this._texel
            const uy = Math.round(c.dot(this._lsUp) / this._texel) * this._texel
            this._snapped.copy(this._lsRight).multiplyScalar(rx).addScaledVector(this._lsUp, uy)
                .addScaledVector(this.sunDir, c.dot(this.sunDir))
            this.sun.target.position.copy(this._snapped)
            this.sun.position.copy(this._snapped).addScaledVector(this.sunDir, 160)
            this.sun.target.updateMatrixWorld()
        }
        if(this.fill && this.camera){
            this.fill.position.copy(this.camera.position).addScaledVector(this.sunDir, -70).setY(this.camera.position.y + 38)
            this.fill.target.position.copy(this.camera.position)
            this.fill.target.updateMatrixWorld()
        }
    }

    Dispose(){
        if(this.dome){
            this.scene.remove(this.dome)
            this.dome.geometry.dispose()
            this.dome.material.dispose()
        }
    }
}
