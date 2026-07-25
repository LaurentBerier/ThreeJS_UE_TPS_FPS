import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, GLSL_NOISE, GLSL_ENCODE, sunDirection, windDirection } from './DesertLook.js'


// Layered storm deck for the golden-hour sky.
//
// The template's fair-weather version was a single fbm field painting white cumulus on blue. This
// is three fields on one dome, which is what makes a dusk sky read as deep rather than flat:
//
//   * a HIGH cirrus sheet, thin and fast, catching the last direct sun on its undersides;
//   * a MID storm layer, the heavy bruised mass that carries most of the drama;
//   * a LOW dust/scud layer hugging the horizon, tying the sky into the dust the desert throws up.
//
// Each drifts at its own speed and scale, so the layers slide across one another and the sky keeps
// moving without anything ever visibly repeating. Coverage is broken on purpose: the brief asks
// for "golden light breaking through", which only happens if there are real gaps for it to break
// through. Where the deck thins toward the sun the light bleeds around the cloud edges.
//
// Drawn on the same transparent BackSide dome the original used: depth-tested so the level occludes
// it normally, never depth-writing, and fog-exempt (it lives past the fog entirely).
export default class DesertClouds extends Component{
    constructor(scene, camera){
        super()
        this.name = 'DesertClouds'
        this.scene = scene
        this.camera = camera
        this.sunDir = sunDirection()
        this.time = 0
    }

    Initialize(){
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            transparent: true,
            depthWrite: false,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
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
                uniform float uTime;
                uniform vec3 uSunDir;
                varying vec3 vDir;
                ${GLSL_NOISE}
                ${GLSL_ENCODE}

                // 2D fbm on the cloud plane. Cheaper than the 3D field the surfaces use, and the
                // deck only ever needs two dimensions.
                float h2(vec2 p){ return dl_hash(vec3(p, 0.0)); }
                float n2(vec2 p){
                    vec2 i = floor(p), f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(h2(i), h2(i + vec2(1,0)), f.x),
                               mix(h2(i + vec2(0,1)), h2(i + vec2(1,1)), f.x), f.y);
                }
                float fbm2(vec2 p){
                    float v = 0.0, a = 0.5;
                    for(int i = 0; i < 5; i++){ v += a * n2(p); p *= 2.07; a *= 0.5; }
                    return v;
                }

                void main(){
                    vec3 dir = normalize(vDir);
                    // Fade out toward and below the horizon so the deck has no hard dome rim and
                    // the sky's dust band shows underneath it.
                    float horizonFade = smoothstep(-0.01, 0.34, dir.y);
                    if(horizonFade <= 0.001){ discard; }

                    float sd = max(dot(dir, normalize(uSunDir)), 0.0);
                    // Project the view direction onto a cloud ceiling. The +0.32 keeps the
                    // projection finite as the view approaches the horizon.
                    vec2 uv = dir.xz / (dir.y * 0.8 + 0.32);

                    // All three layers drift along THE world wind (DesertLook.WIND_AZIMUTH) at
                    // their own speeds — the deck slides the same way the flags stream and the
                    // sand drifts. uv space maps to world xz, so the wind vector drops straight in
                    // (negated: shifting the sample window upwind moves the pattern downwind).
                    ${(() => { const w = windDirection(); return `const vec2 windUV = vec2(${(-w.x).toFixed(4)}, ${(-w.z).toFixed(4)});` })()}

                    // --- Layer 1: high cirrus. Stretched hard on one axis into wind-drawn streaks.
                    vec2 uvH = uv * vec2(0.55, 2.4) + windUV * (uTime * 0.010);
                    float high = fbm2(uvH);
                    high = smoothstep(0.44, 0.78, high);

                    // --- Layer 2: the mid storm mass, warped by a second field so the billows curl.
                    vec2 uvM = uv * 1.05 + windUV * (uTime * 0.0072) + vec2(-windUV.y, windUV.x) * (uTime * 0.0021);
                    float warp = fbm2(uvM * 0.5 + 13.0);
                    float mid = fbm2(uvM + warp * 0.9);
                    float midShape = fbm2(uvM * 2.6 - warp * 0.5 + 5.0);
                    float midCov = smoothstep(0.46, 0.82, mid * 0.74 + midShape * 0.26);
                    // The alien-vista sky is CLEAR overhead — the stars and the moon cluster own
                    // the zenith, and the cloud drama lives low, warm-lit against the dusk band.
                    // (Was a full storm deck: raised thresholds + this altitude fade opened it.)
                    midCov *= 1.0 - smoothstep(0.32, 0.70, dir.y) * 0.78;

                    // --- Layer 3: low dust scud, fast and thin, only near the horizon.
                    vec2 uvL = uv * 2.1 + windUV * (uTime * 0.022) + vec2(-windUV.y, windUV.x) * (uTime * -0.005);
                    float low = smoothstep(0.50, 0.85, fbm2(uvL));
                    low *= smoothstep(0.55, 0.06, dir.y);

                    // --- Shading. Storm cloud at dusk is dark where it is thick and incandescent
                    // where it is thin, so drive brightness off inverse density, not off density.
                    vec3 deepBase  = ${this._c(PALETTE.stoneDark)} * 1.15;      // bruised underside
                    vec3 dustBase  = ${this._c(PALETTE.haze)} * 0.72;
                    // Kept INSIDE gamut. Pushing these above 1.0 does not make a brighter cloud —
                    // the buffer clips — it just clips the red channel first and turns the warm
                    // edge green. Glow is the bloom pass's job, not the colour's.
                    vec3 litEdge   = ${this._c(PALETTE.sun)} * 1.0;
                    vec3 hotEdge   = ${this._c(PALETTE.sunDeep)} * 1.15;

                    // Thin, sunward edges catch the light; thick cores stay bruised and dark.
                    float thin = 1.0 - smoothstep(0.30, 0.92, midCov);
                    vec3 midCol = mix(deepBase, dustBase, thin * 0.55);
                    midCol = mix(midCol, litEdge, pow(sd, 3.0) * thin * 0.85);
                    midCol = mix(midCol, hotEdge, pow(sd, 12.0) * thin);

                    vec3 highCol = mix(dustBase * 1.25, litEdge * 1.2, pow(sd, 2.2) * 0.8);
                    highCol = mix(highCol, hotEdge, pow(sd, 14.0) * 0.7);

                    vec3 lowCol = mix(deepBase * 0.9, ${this._c(PALETTE.haze)} * 1.1, pow(sd, 4.0));

                    // Composite back-to-front: cirrus, then the storm mass, then dust scud.
                    // Cirrus thins toward the zenith too — enough wisp to keep the sky alive
                    // between the moons without ever screening the starfield.
                    vec3 col = highCol;
                    float a = high * 0.30 * (1.0 - smoothstep(0.45, 0.85, dir.y) * 0.6);

                    col = mix(col, midCol, midCov * 0.94);
                    a = a + midCov * 0.90 * (1.0 - a);

                    col = mix(col, lowCol, low * 0.7);
                    a = a + low * 0.55 * (1.0 - a);

                    a *= horizonFade;
                    // Never fully opaque toward the sun: this is the gap the golden light comes
                    // through, and closing it kills the single best moment in the sky.
                    a *= 1.0 - pow(sd, 20.0) * 0.55;

                    gl_FragColor = vec4(dl_toLinear(col), clamp(a, 0.0, 1.0));
                }
            `,
        })

        const dome = new THREE.Mesh(new THREE.SphereGeometry(2500, 56, 36), mat)
        dome.frustumCulled = false
        dome.renderOrder = -999           // over the sky dome, still behind everything solid
        dome.userData.noExport = true
        this.mat = mat
        this.dome = dome
        this.scene.add(dome)
    }

    // Inline a JS colour as a GLSL literal (same trick DesertSky uses — one palette, no drift).
    _c(col){ return `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})` }

    Update(t){
        this.time += t
        if(this.mat){ this.mat.uniforms.uTime.value = this.time }
        if(this.dome && this.camera){ this.dome.position.copy(this.camera.position) }
    }

    Dispose(){
        if(this.dome){
            this.scene.remove(this.dome)
            this.dome.geometry.dispose()
            this.dome.material.dispose()
        }
    }
}
