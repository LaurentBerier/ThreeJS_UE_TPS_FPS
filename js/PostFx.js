import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'


// Post stack: restrained bloom, then one combined finishing pass.
//
// ENCODING, which is the whole trick on three r127 and took measuring the pipeline to pin down.
//
// r127 picks the output encoding from the CURRENT RENDER TARGET, not from renderer.outputEncoding:
// drawing to the screen uses renderer.outputEncoding, drawing into a render target uses that
// target's texture.encoding. A composer's buffers are LinearEncoding, so with a composer attached
// every built-in material writes LINEAR — and the finishing pass has to perform the sRGB
// conversion itself or the whole frame comes out looking like a dark, muddy mess.
//
// The trap is the shaders that DON'T follow that rule. The sky dome, cloud deck, far world,
// atmosphere and impact particles are raw ShaderMaterials, and a raw ShaderMaterial never includes
// three's <encodings_fragment> chunk, so it writes literally whatever its fragment shader
// produces, whatever the render target says. Those colours were authored by eye — i.e. in display
// space — so they were the one group in the scene NOT writing linear, and encoding the frame made
// them roughly a stop and a half too bright while the PBR surfaces beside them were correct.
//
// Fixed at the source rather than here: each of those shaders now ends in dl_toLinear() (see
// GLSL_ENCODE in DesertLook.js). Everything in the buffer is linear, bloom thresholds and blurs in
// the space where that is physically meaningful, and exactly one encode happens — below, at the
// very end, to the whole frame.
//
// Tone mapping is NOT affected: r127 applies renderer.toneMapping inside the material shader
// regardless of render target, so ACES has already run by the time the buffer reaches bloom. That
// means bloom operates on tone-mapped values in [0,1], which is why the threshold sits low.
//
// The finishing pass folds four things into one full-screen draw rather than four:
//   * the linear -> sRGB conversion described above
//   * a split-tone grade (cool the shadows, warm the highlights)
//   * a vignette
//   * the restrained heat shimmer, confined to a band just above the horizon
//
// If anything here throws, Build() returns null and the caller falls back to rendering the scene
// directly — the game must never fail to draw because a cosmetic pass broke.

const FinishShader = {
    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uHorizon: { value: 0.5 },     // screen-space Y of the horizon, updated per frame
        uShimmer: { value: 1.0 },
        uVignette: { value: 0.32 },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uHorizon;
        uniform float uShimmer;
        uniform float uVignette;
        varying vec2 vUv;

        void main(){
            vec2 uv = vUv;

            // --- Heat shimmer. Confined to a narrow band around the horizon, where hot ground
            // actually produces it, and capped at a fraction of a pixel. Anything stronger, or
            // applied full-screen, would smear enemies and attack tells — which the brief rules
            // out. The vertical frequency is kept LOW on purpose: a high-frequency wobble reads as
            // rippling edges on the containers' 1-pixel corrugation lines rather than as heat.
            float band = exp(-pow((uv.y - uHorizon) * 14.0, 2.0));
            float wob = sin(uv.y * 70.0 + uTime * 1.9) * sin(uv.x * 23.0 + uTime * 1.3);
            uv.x += wob * 0.00028 * band * uShimmer;

            vec4 c = texture2D(tDiffuse, uv);

            // --- Split-tone grade. Cool the shadows toward the dusk sky, warm the highlights
            // toward the sun. This is what ties sand, steel and sky into one image.
            //
            // Thresholds are in LINEAR light, not display values (see the header), so they look
            // lower than they "should": linear 0.02 is roughly display 0.16, and linear 0.30 is
            // roughly display 0.58. Grading with display-space numbers here crushed everything
            // below mid-grey to black.
            float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            vec3 shadowTint = vec3(0.90, 0.95, 1.14);
            vec3 highTint   = vec3(1.06, 1.00, 0.90);
            c.rgb *= mix(shadowTint, highTint, smoothstep(0.02, 0.30, lum));
            // A touch of contrast, pivoting on linear mid-grey (0.18), plus a small black lift so
            // shadowed ground stays READABLE dark rather than going to pure black — the brief asks
            // for readable dark areas, and this level fights in the shadow of its own containers.
            c.rgb = max((c.rgb - 0.18) * 1.05 + 0.18, vec3(0.0)) + vec3(0.004, 0.0035, 0.005);

            // --- Vignette. Pulls the eye to the middle of frame, where the crosshair is.
            vec2 d = vUv - 0.5;
            float vig = 1.0 - dot(d, d) * uVignette * 2.2;
            c.rgb *= clamp(vig, 0.0, 1.0);

            // --- Linear -> sRGB. The single encode for the frame; see the header.
            vec3 lo = c.rgb * 12.92;
            vec3 hi = 1.055 * pow(max(c.rgb, vec3(0.0)), vec3(0.41666)) - 0.055;
            c.rgb = mix(hi, lo, step(c.rgb, vec3(0.0031308)));

            gl_FragColor = vec4(c.rgb, 1.0);
        }
    `,
}


export default class PostFx{
    // Returns a PostFx instance, or null if the stack could not be built (caller falls back to
    // renderer.render). Never throws.
    static Build(renderer, scene, camera){
        try{
            return new PostFx(renderer, scene, camera)
        }catch(e){
            console.warn('[PostFx] disabled, rendering directly:', e)
            return null
        }
    }

    constructor(renderer, scene, camera){
        this.renderer = renderer
        this.scene = scene
        this.camera = camera
        this.time = 0

        const size = renderer.getSize(new THREE.Vector2())
        this.composer = new EffectComposer(renderer)
        this.composer.addPass(new RenderPass(scene, camera))

        // Restrained: this is a dusty world, not a bloom demo. Values reaching this pass are
        // tone-mapped AND display-encoded (see header), so nothing exceeds 1.0 and a high threshold
        // would catch nothing at all. 0.80 picks out the sun's core, the sky immediately around it
        // and muzzle flashes — exactly the list that should glow — and leaves sunlit sand alone.
        this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.30, 0.7, 0.80)
        this.composer.addPass(this.bloom)

        this.finish = new ShaderPass(FinishShader)
        this.finish.renderToScreen = true
        this.composer.addPass(this.finish)

        this.SetSize(size.x, size.y)
    }

    SetSize(w, h){
        const dpr = this.renderer.getPixelRatio()
        this.composer.setSize(w, h)
        this.composer.setPixelRatio ? this.composer.setPixelRatio(dpr) : null
        this.bloom.setSize(w * dpr, h * dpr)
    }

    Render(dt){
        this.time += dt
        this.finish.uniforms.uTime.value = this.time

        // Project the world horizon into screen space so the shimmer band tracks the camera as the
        // player looks up and down, instead of sitting at a fixed screen height.
        const dir = new THREE.Vector3()
        this.camera.getWorldDirection(dir)
        const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))
        const halfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5
        this.finish.uniforms.uHorizon.value = 0.5 + (pitch / Math.max(halfFov, 0.001)) * 0.5

        this.composer.render()
    }

    Dispose(){
        this.composer && this.composer.renderTarget1 && this.composer.renderTarget1.dispose()
        this.composer && this.composer.renderTarget2 && this.composer.renderTarget2.dispose()
        this.bloom && this.bloom.dispose && this.bloom.dispose()
    }
}
