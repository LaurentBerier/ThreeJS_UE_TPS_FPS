import * as THREE from 'three'
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js'


// Screen-space ambient occlusion for the r127 pipeline — the single biggest "realism" win for a
// grounded image: the soft contact darkening where geometry meets geometry (feet on sand, crates in
// their own corners, the seams of the citadel) that the flat ambient/HDR fill can't produce on its
// own.
//
// This is a native port in the SPIRIT of 0beqz/realism-effects, not a drop-in of it: that library
// targets three r151+ and the pmndrs `postprocessing` runtime, and leans on its TRAA denoiser to
// clean a noisy hemisphere sampler across frames. We have neither, so:
//   * the depth -> view-position and the neighbour-difference normal reconstruction are lifted from
//     realism-effects' hbao_utils.glsl (getWorldPos / computeWorldNormal), adapted to VIEW space;
//   * the occlusion estimator is a horizon/AlchemyAO-style disk sampler (spatially stable, not
//     temporal) so it looks clean after a single depth-aware blur, with NO per-frame noise animation
//     (animated noise without a temporal accumulator just shimmers).
//
// Structure mirrors UnrealBloomPass: one Pass that owns its internal render targets and does several
// internal full-screen draws. Placed immediately AFTER RenderPass, so the readBuffer handed to
// render() is the scene colour AND carries the scene depth in readBuffer.depthTexture (PostFx wires
// a DepthTexture onto the composer's targets). Three internal draws:
//   1. AO at HALF resolution      -> aoRT   (R = visibility, G = view-space Z for the bilateral)
//   2. depth-aware bilateral blur -> blurRT (kills the disk-sampler grain without crossing edges)
//   3. composite: colour * AO     -> writeBuffer (full res, bilinear upsample of the half-res AO)
//
// AO multiplies the colour BEFORE bloom (occluded creases must not glow) and while the buffer is
// still linear + tone-mapped (see PostFx header) — a plain multiply there darkens correctly and the
// finishing pass grades/encodes the result like everything else.
//
// Every uniform below is live-tunable at runtime via _APP.postFx.ao.* (see the getters at the
// bottom), the same knob-driven workflow as the FinishShader grade. uStrength = 0 hard-disables the
// effect for an instant A/B.

const VERT = /* glsl */`
    varying vec2 vUv;
    void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`

// Shared reconstruction helpers. Depth is the hardware depth from the composer target's DepthTexture
// (non-linear, window space); uProjInv is the camera's inverse projection, so a UV + depth round-trips
// to an exact VIEW-space position regardless of the scene's brutal 0.01 / 3200 near-far ratio (depth
// precision is lavish in the near field, which is the only place AO acts). Normal is reconstructed
// from depth by the realism-effects neighbour-difference method: pick, per axis, whichever of the two
// neighbours lies more nearly on the local plane, so silhouettes don't smear the normal.
const RECONSTRUCT = /* glsl */`
    uniform highp sampler2D tDepth;
    uniform mat4 uProjInv;
    uniform vec2 uResolution;   // FULL-res depth size, for texel-accurate neighbour taps
    uniform float uNormalSign;

    vec3 getViewPos(vec2 uv, float d){
        float z = d * 2.0 - 1.0;
        vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
        vec4 view = uProjInv * clip;
        return view.xyz / view.w;
    }

    vec3 getViewNormal(vec2 uv, vec3 ce){
        vec2 texel = 1.0 / uResolution;
        float c0 = texture2D(tDepth, uv).x;
        float l1 = texture2D(tDepth, uv - vec2(texel.x, 0.0)).x;
        float l2 = texture2D(tDepth, uv - vec2(2.0 * texel.x, 0.0)).x;
        float r1 = texture2D(tDepth, uv + vec2(texel.x, 0.0)).x;
        float r2 = texture2D(tDepth, uv + vec2(2.0 * texel.x, 0.0)).x;
        float b1 = texture2D(tDepth, uv - vec2(0.0, texel.y)).x;
        float b2 = texture2D(tDepth, uv - vec2(0.0, 2.0 * texel.y)).x;
        float t1 = texture2D(tDepth, uv + vec2(0.0, texel.y)).x;
        float t2 = texture2D(tDepth, uv + vec2(0.0, 2.0 * texel.y)).x;
        float dl = abs((2.0 * l1 - l2) - c0);
        float dr = abs((2.0 * r1 - r2) - c0);
        float db = abs((2.0 * b1 - b2) - c0);
        float dt = abs((2.0 * t1 - t2) - c0);
        vec3 dpdx = (dl < dr) ? ce - getViewPos(uv - vec2(texel.x, 0.0), l1)
                              : -ce + getViewPos(uv + vec2(texel.x, 0.0), r1);
        vec3 dpdy = (db < dt) ? ce - getViewPos(uv - vec2(0.0, texel.y), b1)
                              : -ce + getViewPos(uv + vec2(0.0, texel.y), t1);
        // uNormalSign flips the reconstructed facing if a platform winds the cross product the other
        // way; +1 is correct on the reference machine.
        return normalize(cross(dpdx, dpdy)) * uNormalSign;
    }
`

// --- Pass 1: the AO estimate, half resolution. ---
// A spiral of taps in a VIEW-space disk of radius uRadius, projected to screen. Each tap that rises
// above the surface's tangent plane (dot(dir, N) beyond a small bias) occludes, weighted by a smooth
// radial falloff so the disk edge doesn't pop. Interleaved-gradient noise rotates the spiral per
// pixel to trade banding for high-frequency grain the blur then removes. Sky (depth == 1) and
// anything past uFadeEnd are forced fully lit so the dune vista and horizon dome stay clean.
const AO_FRAG = /* glsl */`
    varying vec2 vUv;
    ${RECONSTRUCT}
    uniform vec2 uHalfProj;     // 0.5 * (proj[0][0], proj[1][1]); world radius -> UV radius per axis
    uniform float uNear;
    uniform float uRadius;
    uniform float uBias;
    uniform float uIntensity;
    uniform float uPower;
    uniform float uFadeStart;
    uniform float uFadeEnd;

    const int TAPS = 16;
    const float SPIRAL = 7.0;
    const float TWO_PI = 6.28318530718;

    float ign(vec2 p){
        return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
    }

    void main(){
        float d = texture2D(tDepth, vUv).x;
        // Background / sky: no geometry to occlude. Full visibility (1.0); the blur detects sky from
        // the depth texture and leaves these texels alone.
        if(d >= 1.0){ gl_FragColor = vec4(1.0); return; }

        vec3 P = getViewPos(vUv, d);
        vec3 N = getViewNormal(vUv, P);
        float viewZ = -P.z;

        float rot = ign(gl_FragCoord.xy) * TWO_PI;
        // World radius -> per-axis UV radius at this depth (aspect handled by the two proj scales).
        // Clamped so point-blank surfaces don't sample a third of the screen.
        vec2 radiusUV = min(uRadius * uHalfProj / max(viewZ, uNear), vec2(0.15));

        float occ = 0.0;
        for(int i = 0; i < TAPS; i++){
            float a = (float(i) + 0.5) / float(TAPS);
            float ang = a * SPIRAL * TWO_PI + rot;
            vec2 suv = vUv + vec2(cos(ang), sin(ang)) * a * radiusUV;
            float sd = texture2D(tDepth, suv).x;
            if(sd >= 1.0) continue;                 // sky sample never occludes
            vec3 v = getViewPos(suv, sd) - P;
            float dist = length(v);
            float ndotv = dot(v / max(dist, 1e-4), N);   // sine of elevation above the tangent plane
            float falloff = 1.0 - smoothstep(uRadius * 0.4, uRadius, dist);
            occ += max(0.0, ndotv - uBias) * falloff;
        }

        float ao = clamp(1.0 - (occ / float(TAPS)) * uIntensity, 0.0, 1.0);
        ao = pow(ao, uPower);

        // Distance fade: contact shadows matter within a couple of metres; letting AO run to the
        // horizon just dirties the far dunes and courts depth-precision noise. Full past uFadeEnd.
        float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, viewZ);
        ao = mix(1.0, ao, fade);

        gl_FragColor = vec4(ao);
    }
`

// --- Pass 2: depth-aware bilateral blur, half resolution. ---
// A 5x5 box weighted by linear-eye-depth similarity. Removes the spiral grain while refusing to bleed
// AO across a depth discontinuity, which is what keeps crate edges crisp instead of haloed. Depth is
// reconstructed from the scene depth texture (sampled at the same UVs as the AO), so nothing but AO
// needs to survive in the RGBA8 target. Sky texels (depth == 1) are passed through untouched.
const BLUR_FRAG = /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tAO;
    uniform highp sampler2D tDepth;
    uniform vec2 uTexel;        // 1 / half-res size
    uniform float uDepthSigma;
    uniform float uNear;
    uniform float uFar;

    // Hardware depth (0..1) -> positive linear eye distance in metres, so the bilateral weight is in
    // world units and behaves the same near and far.
    float linearEye(float d){
        float ndc = d * 2.0 - 1.0;
        return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }

    void main(){
        float cd = texture2D(tDepth, vUv).x;
        float ao = texture2D(tAO, vUv).r;
        if(cd >= 1.0){ gl_FragColor = vec4(ao); return; }   // sky: keep full visibility

        float centerZ = linearEye(cd);
        float sum = ao;
        float wsum = 1.0;
        for(int x = -2; x <= 2; x++){
            for(int y = -2; y <= 2; y++){
                if(x == 0 && y == 0) continue;
                vec2 o = vec2(float(x), float(y)) * uTexel;
                float sd = texture2D(tDepth, vUv + o).x;
                if(sd >= 1.0) continue;
                float dz = abs(linearEye(sd) - centerZ);
                float w = exp(-dz * uDepthSigma) * exp(-float(x * x + y * y) * 0.15);
                sum += texture2D(tAO, vUv + o).r * w;
                wsum += w;
            }
        }
        gl_FragColor = vec4(sum / wsum);
    }
`

// --- Pass 3: composite, full resolution. ---
// Multiply the scene colour by the (bilinearly upsampled) blurred AO. mix toward uAoColor rather than
// pure black lets the occlusion carry a whisper of cool bounce instead of reading as dead soot.
// uStrength scales the whole effect (0 = off) for live A/B without touching the estimate.
const COMPOSITE_FRAG = /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tAO;
    uniform vec3 uAoColor;
    uniform float uStrength;

    void main(){
        vec4 col = texture2D(tDiffuse, vUv);
        float ao = texture2D(tAO, vUv).r;
        ao = mix(1.0, ao, uStrength);
        col.rgb *= mix(uAoColor, vec3(1.0), ao);
        gl_FragColor = col;
    }
`


export default class AOPass extends Pass {
    constructor(camera, width, height){
        super()
        this.camera = camera
        this.needsSwap = true

        this._projInv = new THREE.Matrix4()

        // Deliberately RGBA8 (the default type), NOT half-float: a non-renderable float target
        // wouldn't THROW — it would just read back black, and the composite would multiply the whole
        // frame toward black with no way for PostFx.Build's try/catch to catch it. RGBA8 is renderable
        // everywhere. AO lives in .r; the bilateral reconstructs linear depth from the depth texture
        // rather than leaning on a high-precision stored view-Z, so 8 bits is plenty.
        const rtOpts = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            depthBuffer: false,
            stencilBuffer: false,
        }
        this.aoRT = new THREE.WebGLRenderTarget(1, 1, rtOpts)
        this.aoRT.texture.name = 'AOPass.ao'
        this.blurRT = new THREE.WebGLRenderTarget(1, 1, rtOpts)
        this.blurRT.texture.name = 'AOPass.blur'

        this.aoMaterial = new THREE.ShaderMaterial({
            defines: {},
            uniforms: {
                tDepth: { value: null },
                uProjInv: { value: this._projInv },
                uResolution: { value: new THREE.Vector2() },
                uNormalSign: { value: 1.0 },
                uHalfProj: { value: new THREE.Vector2() },
                uNear: { value: camera.near },
                // Defaults tuned live against the over-shoulder desert frame: contact-scale radius,
                // enough intensity to read as grounding without souring into dirt, a gentle power
                // curve, and a distance fade so the open dunes past ~70 m stay clean. All live-tunable.
                uRadius: { value: 0.7 },
                uBias: { value: 0.03 },
                uIntensity: { value: 2.2 },
                uPower: { value: 1.6 },
                uFadeStart: { value: 32.0 },
                uFadeEnd: { value: 72.0 },
            },
            vertexShader: VERT,
            fragmentShader: AO_FRAG,
            depthTest: false,
            depthWrite: false,
        })

        this.blurMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tAO: { value: null },
                tDepth: { value: null },
                uTexel: { value: new THREE.Vector2() },
                uDepthSigma: { value: 6.0 },
                uNear: { value: camera.near },
                uFar: { value: camera.far },
            },
            vertexShader: VERT,
            fragmentShader: BLUR_FRAG,
            depthTest: false,
            depthWrite: false,
        })

        this.compositeMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                tAO: { value: null },
                uAoColor: { value: new THREE.Vector3(0.015, 0.02, 0.03) },
                uStrength: { value: 1.0 },
            },
            vertexShader: VERT,
            fragmentShader: COMPOSITE_FRAG,
            depthTest: false,
            depthWrite: false,
        })

        this.fsQuad = new Pass.FullScreenQuad(this.aoMaterial)

        // CopyShader-free passthrough for the defensive "no depth texture" branch: just blit colour.
        this._copyMaterial = new THREE.ShaderMaterial({
            uniforms: { tDiffuse: { value: null } },
            vertexShader: VERT,
            fragmentShader: /* glsl */`
                varying vec2 vUv; uniform sampler2D tDiffuse;
                void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }
            `,
            depthTest: false,
            depthWrite: false,
        })

        this.setSize(width, height)
    }

    setSize(width, height){
        // Internal AO/blur run at half resolution; the composite is full res. Guard against the 0x0
        // canvas the app can briefly hand us during boot (WindowResizeHanlder before start).
        const w = Math.max(1, Math.floor(width))
        const h = Math.max(1, Math.floor(height))
        const hw = Math.max(1, Math.floor(w / 2))
        const hh = Math.max(1, Math.floor(h / 2))
        this.aoRT.setSize(hw, hh)
        this.blurRT.setSize(hw, hh)
        this.aoMaterial.uniforms.uResolution.value.set(w, h)
        this.blurMaterial.uniforms.uTexel.value.set(1 / hw, 1 / hh)
    }

    render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */){
        const depthTexture = readBuffer.depthTexture

        // No depth (unsupported platform, or a pass-order change) => never break the frame; blit the
        // scene colour straight through so the game looks exactly like the pre-AO build.
        if(!depthTexture){
            this._passthrough(renderer, writeBuffer, readBuffer)
            return
        }

        // Per-frame camera state. projectionMatrixInverse isn't guaranteed fresh on r127, so invert
        // here; uHalfProj carries the two projection scales for the world->screen radius mapping.
        this._projInv.copy(this.camera.projectionMatrix).invert()
        const e = this.camera.projectionMatrix.elements
        this.aoMaterial.uniforms.uHalfProj.value.set(0.5 * e[0], 0.5 * e[5])
        this.aoMaterial.uniforms.uNear.value = this.camera.near
        this.aoMaterial.uniforms.tDepth.value = depthTexture

        // 1. AO -> aoRT (half res). The full-screen triangle covers every texel and the renderer's
        // autoClear handles the wipe, so no explicit clear is needed on the internal targets.
        this.fsQuad.material = this.aoMaterial
        renderer.setRenderTarget(this.aoRT)
        this.fsQuad.render(renderer)

        // 2. bilateral blur -> blurRT (half res)
        this.blurMaterial.uniforms.tAO.value = this.aoRT.texture
        this.blurMaterial.uniforms.tDepth.value = depthTexture
        this.blurMaterial.uniforms.uNear.value = this.camera.near
        this.blurMaterial.uniforms.uFar.value = this.camera.far
        this.fsQuad.material = this.blurMaterial
        renderer.setRenderTarget(this.blurRT)
        this.fsQuad.render(renderer)

        // 3. composite colour * AO -> writeBuffer (full res)
        this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture
        this.compositeMaterial.uniforms.tAO.value = this.blurRT.texture
        this.fsQuad.material = this.compositeMaterial
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
        if(this.clear) renderer.clear()
        this.fsQuad.render(renderer)
    }

    _passthrough(renderer, writeBuffer, readBuffer){
        this._copyMaterial.uniforms.tDiffuse.value = readBuffer.texture
        this.fsQuad.material = this._copyMaterial
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
        if(this.clear) renderer.clear()
        this.fsQuad.render(renderer)
    }

    dispose(){
        this.aoRT.dispose()
        this.blurRT.dispose()
        this.aoMaterial.dispose()
        this.blurMaterial.dispose()
        this.compositeMaterial.dispose()
        this._copyMaterial.dispose()
        this.fsQuad.dispose()
    }
}
