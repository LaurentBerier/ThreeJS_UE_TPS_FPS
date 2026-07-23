import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, GLSL_NOISE, GLSL_SKY, GLSL_ENCODE, sunDirection, PLAY_CENTER } from './DesertLook.js'


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
                void main(){
                    vec3 dir = normalize(vDir);
                    vec3 sun = normalize(uSunDir);
                    vec3 col = dl_skyColor(dir, sun) + dl_sunDisc(dir, sun);
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
        const hemi = new THREE.HemisphereLight(PALETTE.skyAmbient.getHex(), PALETTE.sandBounce.getHex(), 0.40)
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
        // Exponential-squared haze in the sky's own horizon colour.
        //
        // Density is chosen against two fixed points. COMBAT: at 40 m — beyond any engagement —
        // it removes under 1% of contrast, so enemies, muzzle flashes and attack telegraphs are
        // untouched. THE LANDMARK: the castle stands ~600 m from the start overlook and the brief
        // requires it readable from most outdoor areas; at 0.0011 it keeps ~60% of its contrast
        // there — present, solid, convincingly distant. (The old depot value of 0.0028 was tuned
        // for a 56 m playfield and erased 95% of anything at 600 m — the vista simply vanished.)
        this.scene.fog = new THREE.FogExp2(PALETTE.haze.getHex(), 0.0011)
    }

    Update(t){
        this.time += t
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
