import * as THREE from 'three'

// HDR image-based lighting for the whole scene — the r127-safe way.
//
// The brief: "shadows are too dark, light the scene with an HDR". The classic three.js answer is
// RGBELoader -> PMREMGenerator -> scene.environment, but on the pinned r127 PMREM output breaks
// this project's materials (RGBE-tagged half-float target decodes to Inf/NaN => solid black — see
// the note in DesertSky.js). So this module builds the SAME two ingredients PMREM would have
// provided, using only paths that work on r127:
//
//   * SPECULAR: the .hdr equirect is rendered once into a mipmapped RGBA16F cube render target
//     (WebGLCubeRenderTarget.fromEquirectangularTexture — no PMREM involved). Assigned to
//     scene.environment, every MeshStandardMaterial picks it up through the plain ENVMAP_TYPE_CUBE
//     path, whose roughness-based mip selection r127 handles fine.
//
//   * DIFFUSE: a LightProbe whose 9 spherical-harmonics coefficients are projected on the CPU
//     straight from the .hdr's float pixels (r127's LightProbeGenerator only reads 8-bit targets,
//     which would clamp the HDR away). This is what actually LIFTS THE SHADOWS: every surface,
//     shadowed or not, receives sky-coloured ambient from above and warm ground bounce from below,
//     with real directional variation — instead of the flat single-tone hemisphere floor.
//
// The HDR's own sun is ALIGNED to the game's sun before either step: the equirect columns are
// rolled so the image's brightest bearing lands on DesertLook.sunDirection()'s azimuth. Without
// this the environment would rim-light everything from a bearing that disagrees with the one
// shadow-casting key light (two suns, one of them a lie).
//
// Pure build-time cost (one texture repack + one 6-face render + one SH pass, ~tens of ms at 1k);
// nothing here runs per frame.

// Decode table for IEEE half floats (RGBELoader with HalfFloatType hands back Uint16 halves).
// 64k-entry LUT: builds in ~2 ms, makes every later per-texel read a plain array lookup.
let HALF_LUT = null
function halfLut(){
    if(HALF_LUT){ return HALF_LUT }
    const lut = new Float32Array(65536)
    for(let h = 0; h < 65536; h++){
        const s = (h & 0x8000) ? -1 : 1
        const e = (h >> 10) & 0x1f
        const m = h & 0x3ff
        lut[h] = e === 0 ? s * m * Math.pow(2, -24)
            : e === 31 ? (m ? NaN : s * Infinity)
            : s * (1 + m / 1024) * Math.pow(2, e - 15)
    }
    HALF_LUT = lut
    return lut
}
const HALF_ONE = 0x3c00

// Build the environment. `hdrTexture` is the DataTexture RGBELoader produced (HalfFloatType or
// FloatType, RGB or RGBA); `sunDir` the world-space unit vector TOWARD the sun the environment
// must agree with. Returns { envMap, probe, renderTarget, dispose }.
export function BuildHdrEnvironment(renderer, hdrTexture, sunDir, opts = {}){
    const cubeSize = opts.cubeSize ?? 256
    const probeIntensity = opts.probeIntensity ?? 1.0
    // SH input luminance clamp. The raw sun disc can be thousands of times brighter than the sky;
    // projected into only 9 SH terms that produces ringing — NEGATIVE irradiance patches on the
    // side facing away from the sun, which render as dirty black smudges. Clamping the input keeps
    // the sky/ground COLOUR distribution while the (separate) directional key light supplies the
    // sun's actual punch. The env cube keeps the unclamped values for speculars.
    const probeClampLum = opts.probeClampLum ?? 12.0

    const img = hdrTexture.image
    const W = img.width, H = img.height
    const src = img.data
    const isHalf = src instanceof Uint16Array
    const comps = src.length / (W * H)   // 3 (RGBFormat) from RGBELoader, 4 if RGBA
    const lut = isHalf ? halfLut() : null
    const px = isHalf ? (i) => lut[src[i]] : (i) => src[i]

    // ---- 1. Read the image's layout: brightest column (the sun's bearing) + which row is the sky.
    // Luminance is cos(latitude)-weighted so overrepresented pole texels don't skew the column vote.
    // Row-0-side detection compares the top and bottom 10% of rows: outdoor HDRIs are always
    // brighter on the sky side, and knowing which side that is makes the vertical orientation
    // self-calibrating instead of trusting any scanline-order convention.
    const colLum = new Float32Array(W)
    let headLum = 0, tailLum = 0
    const headRows = Math.max(1, Math.floor(H * 0.1))
    for(let r = 0; r < H; r += 2){
        const lat = ((r + 0.5) / H - 0.5) * Math.PI
        const w = Math.cos(lat)
        for(let c = 0; c < W; c += 2){
            const i = (r * W + c) * comps
            const lum = (0.2126 * px(i) + 0.7152 * px(i + 1) + 0.0722 * px(i + 2)) * w
            colLum[c] += lum
            if(r < headRows){ headLum += lum }
            if(r >= H - headRows){ tailLum += lum }
        }
    }
    let brightestCol = 0
    for(let c = 2; c < W; c += 2){ if(colLum[c] > colLum[brightestCol]){ brightestCol = c } }
    // GL samples v=1 (up, +Y) from the LAST data row; if the sky sits at row 0, flip vertically.
    const flip = headLum > tailLum

    // ---- 2. Repack into RGBA (renderable/filterable — 3-channel float formats are neither on
    // WebGL2) while rolling the columns so the sun lands on the game's sun azimuth, and flipping
    // rows if needed. equirect u = atan2(dir.z, dir.x)/2pi + 0.5 (three's equirectUv convention).
    const targetU = Math.atan2(sunDir.z, sunDir.x) / (2 * Math.PI) + 0.5
    const targetCol = Math.round(targetU * W) % W
    const shift = ((targetCol - brightestCol) % W + W) % W
    const out = isHalf ? new Uint16Array(W * H * 4) : new Float32Array(W * H * 4)
    const alpha = isHalf ? HALF_ONE : 1.0
    for(let r = 0; r < H; r++){
        const sr = flip ? (H - 1 - r) : r
        for(let c = 0; c < W; c++){
            const sc = (c - shift + W) % W       // dst col c reads src col (c - shift)
            const si = (sr * W + sc) * comps
            const di = (r * W + c) * 4
            out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]
            out[di + 3] = alpha
        }
    }

    const eqTex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, isHalf ? THREE.HalfFloatType : THREE.FloatType)
    eqTex.encoding = THREE.LinearEncoding
    eqTex.wrapS = THREE.RepeatWrapping
    eqTex.flipY = false
    // These are COPIED onto the cube target by fromEquirectangularTexture — this is how the cube
    // ends up mipmapped + trilinear, which the roughness-based env sampling needs.
    eqTex.generateMipmaps = true
    eqTex.minFilter = THREE.LinearMipmapLinearFilter
    eqTex.magFilter = THREE.LinearFilter
    eqTex.needsUpdate = true

    // ---- 3. Specular: one-shot equirect -> cube render. RGBA16F/32F cube, mips, linear encoding.
    const renderTarget = new THREE.WebGLCubeRenderTarget(cubeSize)
    renderTarget.fromEquirectangularTexture(renderer, eqTex)
    eqTex.dispose()   // the cube target owns a GPU copy now; the equirect upload is dead weight

    // ---- 4. Diffuse: SH9 irradiance projected from the SAME rolled/flipped RGBA data.
    // Solid angle of an equirect texel is proportional to cos(latitude); normalisation mirrors
    // LightProbeGenerator (scale by 4pi / totalWeight). 2x2 subsampling: SH9 is far too smooth to
    // notice, and it quarters the cost.
    const outPx = isHalf ? (i) => lut[out[i]] : (i) => out[i]
    const sh = new THREE.SphericalHarmonics3()
    const coeffs = sh.coefficients
    const basis = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    const dir = new THREE.Vector3()
    let totalWeight = 0
    for(let r = 0; r < H; r += 2){
        const v = (r + 0.5) / H
        const lat = (v - 0.5) * Math.PI
        const cosLat = Math.cos(lat), sinLat = Math.sin(lat)
        for(let c = 0; c < W; c += 2){
            const u = (c + 0.5) / W
            const phi = (u - 0.5) * 2 * Math.PI
            dir.set(Math.cos(phi) * cosLat, sinLat, Math.sin(phi) * cosLat)

            const i = (r * W + c) * 4
            let R = outPx(i), G = outPx(i + 1), B = outPx(i + 2)
            const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B
            if(lum > probeClampLum){ const k = probeClampLum / lum; R *= k; G *= k; B *= k }

            const w = cosLat
            totalWeight += w
            THREE.SphericalHarmonics3.getBasisAt(dir, basis)
            for(let j = 0; j < 9; j++){
                coeffs[j].x += basis[j] * R * w
                coeffs[j].y += basis[j] * G * w
                coeffs[j].z += basis[j] * B * w
            }
        }
    }
    const norm = (4 * Math.PI) / totalWeight
    for(let j = 0; j < 9; j++){ coeffs[j].multiplyScalar(norm) }

    const probe = new THREE.LightProbe(sh)
    probe.intensity = probeIntensity

    return {
        envMap: renderTarget.texture,
        probe,
        renderTarget,
        dispose(){ renderTarget.dispose() },
    }
}
