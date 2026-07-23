import * as THREE from 'three'


// Shared art-direction layer for the dark sci-fi desert overhaul.
//
// This file owns ONE thing: how surfaces LOOK. It holds the palette every other world module
// reads from, a small GLSL noise library, and a set of "graders" that re-dress an existing
// MeshStandardMaterial in place via onBeforeCompile.
//
// Grading rather than replacing matters here. The level ships as 70 shipping containers whose
// CORRUGATION, door furniture, hinges and corner castings live entirely in a normal map
// (cont_Normal.png — the meshes are only 426 triangles each), while the printed cargo LETTERING
// and owner placards live in the base-colour map. So the overhaul keeps the normal/roughness maps
// (all the physical relief survives) and throws the base-colour map away, replacing it with
// procedural oxidised metal, scorched concrete and rusted bronze. That removes every letter, code
// and branded marking from the world for free, without touching a single vertex — and vertices are
// exactly what the physics colliders, the navmesh and the camera boom are built from.
//
// Everything here is fragment-stage only. No geometry, no transforms, no collision.
export const PALETTE = {
    // Sun / key light through late-afternoon dust.
    sun:          new THREE.Color(0xffb063),
    sunDeep:      new THREE.Color(0xff7a2a),   // low-horizon core, hotter and more saturated
    // Sky + shadow. Shadows in a desert dusk go cool and slightly violet, never neutral grey.
    skyHigh:      new THREE.Color(0x2a3a5c),
    skyLow:       new THREE.Color(0xc98a52),
    shadowTint:   new THREE.Color(0x4a5170),
    // Ground bounce — a huge warm reflector under everything.
    sandBounce:   new THREE.Color(0xc98a4e),
    // Ambient coming DOWN out of the sky. Not the zenith blue: at dusk a flat desert floor sees
    // mostly the warm horizon band, so a literally-blue hemisphere light desaturates the sand to
    // grey. This is the dusty violet-warm average the ground actually receives.
    skyAmbient:   new THREE.Color(0x5c5262),
    // Surfaces.
    sandLit:      new THREE.Color(0xd8a25c),
    sandDark:     new THREE.Color(0x966640),
    stoneDark:    new THREE.Color(0x2f2a26),
    // Structure albedos are deliberately DARK. three treats material.color as linear, and under a
    // 3.2-intensity key a mid-grey albedo tone-maps to near-white — which made the containers the
    // brightest thing on screen and stole the read from the sand. The sand has to stay the
    // brightest surface: it is the bright background that dark enemy silhouettes are legible
    // against, so it is a combat-readability constraint, not just a taste one.
    // ...and they have to be darker than they look like they should be, because of the sun angle.
    // At 15 degrees elevation a vertical container face catches cos(15) = 0.97 of the key while the
    // ground catches sin(15) = 0.26 — the walls receive 3.7x the light the sand does. Matching a
    // structure's on-screen value to the sand therefore needs an albedo roughly a quarter of it.
    // Measured: sand albedo luminance is 0.66, so structures sit near 0.16.
    concrete:     new THREE.Color(0x261f18),
    steelBlack:   new THREE.Color(0x161719),
    rust:         new THREE.Color(0x6b3417),
    bronze:       new THREE.Color(0x3a2413),
    dust:         new THREE.Color(0xb9945f),
    // Very limited cyan-blue emissive technology — the ONLY cool accent in the world.
    techCyan:     new THREE.Color(0x2fd4e0),
    haze:         new THREE.Color(0xb87a45),
}

// Where the sun sits. Everything else in the world orients to this: the fortress is placed just
// beside it so it reads as a backlit silhouette, the cloud deck brightens toward it, the sand
// bounce comes from it, and the light shafts fan out from it.
// azimuth: compass angle in radians (0 = +X, increasing toward +Z). elevation: above the horizon.
export const SUN_AZIMUTH = THREE.MathUtils.degToRad(-118)
// 15 degrees is the compromise the whole look balances on. Lower reads more dramatic in the sky,
// but the ground only receives sin(elevation) of the key — at 6 degrees the sand gets 10% of the
// sun and goes dead grey under ambient, losing the ochre the entire brief is built around. At 15
// the dunes take real warm light, the grazing angle rakes across the wind ripples, and shadows
// still run nearly four times the height of what casts them.
export const SUN_ELEVATION = THREE.MathUtils.degToRad(15)

export function sunDirection(){
    // Unit vector pointing FROM the world TOWARD the sun.
    const c = Math.cos(SUN_ELEVATION)
    return new THREE.Vector3(
        Math.cos(SUN_AZIMUTH) * c,
        Math.sin(SUN_ELEVATION),
        Math.sin(SUN_AZIMUTH) * c,
    ).normalize()
}

// The playable footprint (matches the journey terrain's centre/size — see JourneyWorld.WORLD).
// The far scenery keeps clear of this square entirely, so nothing decorative can ever intrude on
// movement, navigation or the camera. RADIUS covers the square's corners (320·√2 ≈ 453).
export const PLAY_CENTER = new THREE.Vector2(0, 0)
export const PLAY_RADIUS = 453


// ---------------------------------------------------------------------------------------------
// GLSL building blocks. Value noise + fbm, cheap enough to run per-pixel on every surface in the
// level. Kept in one string so every grader shares the same noise field and the world stays
// visually coherent (the same dust drifts across sand, steel and stone).
// ---------------------------------------------------------------------------------------------
export const GLSL_NOISE = /* glsl */`
float dl_hash(vec3 p){
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float dl_noise(vec3 x){
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dl_hash(i + vec3(0,0,0)), dl_hash(i + vec3(1,0,0)), f.x),
                   mix(dl_hash(i + vec3(0,1,0)), dl_hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(dl_hash(i + vec3(0,0,1)), dl_hash(i + vec3(1,0,1)), f.x),
                   mix(dl_hash(i + vec3(0,1,1)), dl_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float dl_fbm(vec3 p){
    float v = 0.0, a = 0.5;
    for(int i = 0; i < 4; i++){ v += a * dl_noise(p); p *= 2.02; a *= 0.5; }
    return v;
}
// Ridged variant — gives rust crusts and rock strata a harder, flakier edge than plain fbm.
float dl_ridge(vec3 p){
    float v = 0.0, a = 0.5;
    for(int i = 0; i < 4; i++){ v += a * (1.0 - abs(2.0 * dl_noise(p) - 1.0)); p *= 2.13; a *= 0.5; }
    return v;
}
`


// The sky, as a function.
//
// This lives here rather than in DesertSky because three separate systems have to agree on it and
// would otherwise drift apart: the dome is drawn with it, distant scenery fades into it (so ridges
// dissolve into exactly the colour behind them, with no horizon seam), and metal surfaces reflect
// it. Colours are interpolated in from the palette above, so there is one source of truth.
const c = (col) => `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})`
export const GLSL_SKY = /* glsl */`
vec3 dl_skyColor(vec3 dir, vec3 sunDir){
    float t = clamp(dir.y, -1.0, 1.0);
    float sd = dot(normalize(dir), sunDir);

    // Vertical gradient: cool violet zenith -> dusty mauve -> hot amber at the horizon.
    vec3 zenith = ${c(PALETTE.skyHigh)} * 0.55;
    vec3 mid    = mix(${c(PALETTE.skyHigh)}, ${c(PALETTE.skyLow)}, 0.55) * 0.9;
    vec3 horiz  = ${c(PALETTE.skyLow)};

    vec3 col = mix(mid, zenith, smoothstep(0.10, 0.70, t));
    col = mix(horiz, col, smoothstep(-0.02, 0.30, t));

    // Sun-side warming: a broad wash pulling the whole quadrant orange, so the sky reads as
    // directional even where the disc itself is behind cloud.
    float warm = pow(clamp(sd * 0.5 + 0.5, 0.0, 1.0), 3.5);
    col = mix(col, ${c(PALETTE.sunDeep)} * 1.25, warm * 0.55 * smoothstep(0.55, -0.05, t));

    // Dust band hugging the horizon — thick, warm, and what everything distant fades into.
    col = mix(col, ${c(PALETTE.haze)} * 1.15, exp(-abs(t) * 9.0) * 0.55);

    // Below the horizon: dark warm haze standing in for ground lost in dust.
    col = mix(col, ${c(PALETTE.haze)} * 0.30, smoothstep(0.0, -0.16, t));
    return col;
}

// The sun disc and its glow, kept separate from dl_skyColor. The dome wants it; reflections and
// distance haze do NOT — a mirrored sun on a rusted container reads as a bug, and a ridge fading
// into a value of 14.0 blows out to white.
vec3 dl_sunDisc(vec3 dir, vec3 sunDir){
    float sd = clamp(dot(normalize(dir), sunDir), 0.0, 1.0);
    float disc = smoothstep(0.9982, 0.9994, sd);
    float glow = pow(sd, 260.0) * 2.2 + pow(sd, 22.0) * 0.45;
    // Deliberately far above 1.0 so filmic tone mapping keeps a hot white core and the bloom pass
    // has something real to catch.
    return ${c(PALETTE.sunDeep)} * glow + vec3(1.0, 0.86, 0.66) * disc * 14.0;
}
`


// sRGB -> linear, for the raw ShaderMaterials in this overhaul (sky dome, cloud deck, far world,
// atmosphere, impact particles).
//
// three's built-in materials pick up <encodings_fragment> automatically and write whatever space
// the current render target asks for. A raw ShaderMaterial does not, so it writes exactly what its
// fragment shader produces — and these shaders' colours were authored by eye, i.e. in DISPLAY
// space. That is invisible when rendering straight to the screen, and becomes very visible the
// moment a post-processing composer is attached: the scene then lands in a LINEAR render target,
// the finishing pass encodes it once, and every hand-tuned shader in the world comes out a stop
// and a half too bright while the PBR materials around them are correct.
//
// Calling this on the final colour of each custom shader puts them in the same space as everything
// else, so exactly one encode happens, at the end, to the whole frame.
// The clamp is not defensive tidying, it is load-bearing. These shaders deliberately author values
// above 1.0 (a sun disc at 14, cloud edges at 1.5) and, unlike a built-in material, they get no
// tone mapping to roll that back down. Running the transfer function on an out-of-gamut colour
// exaggerates the channel ratios before the 8-bit target clips them, so a warm cloud edge of
// (1.55, 1.07, 0.61) came out clipped to (1, 1, 0.61) — bright GREEN in a sky that has no green in
// its palette. Clamping first costs nothing (the target clips anyway) and keeps the hue.
export const GLSL_ENCODE = /* glsl */`
vec3 dl_toLinear(vec3 c){
    c = clamp(c, 0.0, 1.0);
    return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, step(c, vec3(0.04045)));
}
`


// Inject `code` around the first `token` present in a shader source, falling back through a list
// of alternates. three's chunk names have moved around between releases; this keeps the graders
// working if the pinned three version is ever bumped, instead of silently no-op'ing.
function injectBefore(src, tokens, code){
    for(const token of tokens){
        if(src.includes(token)){ return src.replace(token, code + '\n' + token) }
    }
    return src
}
function injectAfter(src, tokens, code){
    for(const token of tokens){
        if(src.includes(token)){ return src.replace(token, token + '\n' + code) }
    }
    return src
}

// Standard world-space varyings for every grader: position and normal, both in WORLD space so the
// procedural weathering is anchored to the level rather than sliding across UVs or with the camera.
// Works for skinned meshes too — `transformed` is already post-skinning at this point.
const WORLD_VARYINGS_DECL = /* glsl */`
varying vec3 dlWorldPos;
varying vec3 dlWorldNrm;
`
const WORLD_VARYINGS_VERT = /* glsl */`
dlWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
dlWorldNrm = normalize(mat3(modelMatrix) * objectNormal);
`

function addWorldVaryings(shader){
    shader.vertexShader = 'varying vec3 dlWorldPos;\nvarying vec3 dlWorldNrm;\n' + shader.vertexShader
    shader.vertexShader = injectBefore(shader.vertexShader,
        ['#include <project_vertex>'], WORLD_VARYINGS_VERT)
    shader.fragmentShader = WORLD_VARYINGS_DECL + GLSL_NOISE + shader.fragmentShader
}

// Chunk anchors, most-specific first.
//
// The surface block goes AFTER metalnessmap_fragment: that chunk and the roughnessmap one just
// above it are what declare `roughnessFactor` and `metalnessFactor`, so anything wanting to write
// them has to land downstream of both. `diffuseColor` is already live from map_fragment onward.
const SURFACE_ANCHOR = ['#include <metalnessmap_fragment>', '#include <roughnessmap_fragment>']
// Normals are established by normal_fragment_begin/_maps, both of which run before this.
const NORMAL_ANCHOR = ['#include <emissivemap_fragment>', '#include <lights_physical_fragment>']
// `outgoingLight` is summed on the line immediately preceding this.
const OUTPUT_ANCHOR = ['#include <output_fragment>', 'gl_FragColor = vec4( outgoingLight, diffuseColor.a );']


// ---------------------------------------------------------------------------------------------
// Structures — the shipping containers that ARE the level's cover, corridors and arenas.
//
// family: 'concrete' | 'steel' | 'bronze'. The level ships three container materials (white / blue
// / yellow) and the three map onto three distinct weathered families. Keeping them distinguishable
// is deliberate: players read this level's layout by container colour, so collapsing everything to
// one grey would quietly damage navigation even though no geometry moved.
// ---------------------------------------------------------------------------------------------
export function gradeStructure(material, family){
    const base = { concrete: PALETTE.concrete, steel: PALETTE.steelBlack, bronze: PALETTE.bronze }[family]
    const familyId = { concrete: 0, steel: 1, bronze: 2 }[family]

    // Drop the base-colour map: that texture is where every cargo code, weight placard and owner
    // marking is printed. The normal + roughness maps stay, so all the corrugation survives.
    material.map = null
    material.color.copy(base)
    // Metalness stays LOW even on the steel family, and that is physical, not a workaround: a
    // metal's only response is what it reflects, and none of these surfaces are bare metal any
    // more. Oxide crust, baked-on dust and sand-blasting are all dielectric layers. High metalness
    // on a rusted container is what turns it into a flat black hole. The sky reflection injected
    // below then supplies the sheen that low metalness gives up.
    material.metalness = family === 'concrete' ? 0.02 : 0.16
    material.roughness = family === 'concrete' ? 0.94 : 0.7
    if(material.normalScale){ material.normalScale.set(1.25, 1.25) }

    material.userData.dlFamily = family
    material.customProgramCacheKey = () => 'dl-structure-' + familyId

    material.onBeforeCompile = (shader) => {
        addWorldVaryings(shader)
        shader.uniforms.dlSand = { value: PALETTE.sandLit.clone() }
        shader.uniforms.dlRust = { value: PALETTE.rust.clone() }
        shader.uniforms.dlDust = { value: PALETTE.dust.clone() }
        shader.uniforms.dlFamily = { value: familyId }
        shader.uniforms.dlSunDir = { value: sunDirection() }

        shader.fragmentShader = GLSL_SKY + shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            /* glsl */`
            uniform vec3 dlSand;
            uniform vec3 dlRust;
            uniform vec3 dlDust;
            uniform float dlFamily;
            uniform vec3 dlSunDir;
            // Carried from the surface block to the output block. Both injections live inside
            // main(), so a plain local declared here is visible to each of them.
            vec3 dlSkyRefl = vec3(0.0);
            void main() {`)

        shader.fragmentShader = injectAfter(shader.fragmentShader, SURFACE_ANCHOR, /* glsl */`
        {
            vec3 wp = dlWorldPos;
            vec3 wn = normalize(dlWorldNrm);
            float up = max(wn.y, 0.0);

            // Large-scale panel-to-panel variation. Keyed on world position, so all 70 containers
            // share ONE material and ONE shader program yet none of them look alike.
            float unit = dl_fbm(floor(wp * 0.32) * 1.7 + dlFamily * 11.0);

            // Vertical corrosion streaks running down from every horizontal edge — the single most
            // recognisable "abandoned in a desert for decades" cue.
            float streak = dl_fbm(vec3(wp.x * 5.5, wp.y * 0.55, wp.z * 5.5));
            streak *= smoothstep(0.62, 0.05, fract(wp.y * 0.38));

            // Rust. Isotropic noise alone reads as leopard print, which is the giveaway of
            // procedural weathering: real corrosion is GRAVITY-ORGANISED. It starts at a seam or a
            // fixing, runs DOWN, and only some panels have gone over at all. So three terms:
            //   panel  — which panels are corroding (coarse, per-panel, mostly zero)
            //   run    — vertical smear, stretched ~6x on Y so blooms pull downward
            //   pit    — fine flaking that breaks up the edge of the run
            float panel = smoothstep(0.42, 0.80, dl_fbm(floor(wp * 0.42) * 2.3 + 17.0 + dlFamily));
            float run = dl_ridge(vec3(wp.x * 4.2, wp.y * 0.7, wp.z * 4.2) + unit * 4.0);
            float pit = dl_ridge(wp * 15.0 + 5.0);
            float rust = smoothstep(0.50, 0.86, run) * panel;
            rust *= 0.6 + 0.4 * smoothstep(0.32, 0.78, pit);
            rust = mix(rust, rust * 0.25, step(dlFamily, 0.5));    // concrete oxidises far less

            // Scorching — soot blooms, heavier low down where blast and fire pool.
            float scorch = smoothstep(0.55, 0.95, dl_fbm(wp * 0.55 + 21.0));
            scorch *= mix(0.35, 1.0, smoothstep(3.2, 0.2, wp.y));

            // Wind-blown sand: piles against the base (world Y is the real ground datum here, so
            // only ground-level containers get the drift — stacked ones just get dust on top) and
            // settles on every upward face.
            float drift = smoothstep(0.85, -0.05, wp.y) * (0.55 + 0.45 * dl_fbm(wp * 2.2));
            float settle = pow(up, 2.5) * (0.45 + 0.55 * dl_fbm(wp * 3.1 + 7.0));
            float sand = clamp(max(drift * 1.15, settle * 0.85), 0.0, 1.0);

            vec3 col = diffuseColor.rgb;
            col *= 0.70 + 0.30 * unit;                                  // per-container value spread
            col = mix(col, col * vec3(0.55, 0.5, 0.48), scorch * 0.8);  // soot
            col = mix(col, dlRust, rust * 0.55);                        // oxidation
            col = mix(col, dlRust * 0.55, streak * 0.30);               // rust runs
            col = mix(col, dlSand * 0.92, sand * 0.72);                 // sand
            diffuseColor.rgb = col;

            // Remap the packed roughness map into a MATTE range instead of using it raw. The
            // shipped texture has near-zero roughness over the door panels — showroom paint — and
            // under a 3.2-intensity key that specular lobe washed whole containers out to white
            // even after their albedo was darkened to near-black. Nothing in a scoured desert is
            // glossy. The map still supplies its variation, just inside 0.62..0.98.
            roughnessFactor = 0.62 + 0.36 * clamp(roughnessFactor, 0.0, 1.0);
            roughnessFactor = clamp(mix(roughnessFactor, 0.99, max(sand, rust * 0.7)), 0.55, 1.0);
            metalnessFactor *= (1.0 - 0.85 * max(sand, rust * 0.55));

            // Analytic sky reflection, standing in for an environment probe (see DesertSky for why
            // there isn't one). Fresnel-weighted, so it only shows at grazing angles — which is
            // exactly where a real dusty panel picks the sky up — and killed off wherever the
            // surface has gone to sand or rust, because neither of those reflects anything.
            //
            // Computed here but ADDED AT THE OUTPUT STAGE, not folded into diffuseColor. A
            // reflection is outgoing radiance; adding it to albedo means multiplying it by the
            // key light as well, which on the long grazing container walls — precisely where
            // fresnel peaks — was inflating them by a further 3x.
            vec3 Vw = normalize(cameraPosition - dlWorldPos);
            vec3 Nw = normalize(dlWorldNrm);
            float fres = pow(clamp(1.0 - abs(dot(Nw, Vw)), 0.0, 1.0), 4.0);
            vec3 refl = reflect(-Vw, Nw);
            float clean = (1.0 - max(sand, rust)) * (1.0 - roughnessFactor * 0.75);
            dlSkyRefl = dl_skyColor(normalize(refl), normalize(dlSunDir)) * fres * clean * 0.22;
        }
        `)

        shader.fragmentShader = injectBefore(shader.fragmentShader, OUTPUT_ANCHOR, /* glsl */`
        outgoingLight += dlSkyRefl;
        `)

        material.userData.dlShader = shader
    }
    material.needsUpdate = true
    return material
}


// ---------------------------------------------------------------------------------------------
// Ground — the heightfield terrain becomes ochre desert sand.
//
// The terrain mesh carries no UVs (it is generated straight into world space so the collider can
// share its vertex buffer 1:1), so everything here is driven from world XZ. The dune ripples are a
// pure NORMAL perturbation: the surface the player walks on, the foot IK samples and the camera
// sweeps against is bit-for-bit the same heightfield as before.
// ---------------------------------------------------------------------------------------------
export function gradeGround(material){
    material.color.copy(PALETTE.sandLit)
    material.roughness = 0.96
    material.metalness = 0.0
    material.customProgramCacheKey = () => 'dl-ground'

    material.onBeforeCompile = (shader) => {
        addWorldVaryings(shader)
        shader.uniforms.dlSandLit = { value: PALETTE.sandLit.clone() }
        shader.uniforms.dlSandDark = { value: PALETTE.sandDark.clone() }
        shader.uniforms.dlGravel = { value: PALETTE.stoneDark.clone() }

        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            /* glsl */`
            uniform vec3 dlSandLit;
            uniform vec3 dlSandDark;
            uniform vec3 dlGravel;

            // Wind-ripple field. Two crossed, noise-warped wave trains — the classic aeolian
            // pattern. Returns a height so the normal can be taken as its analytic gradient.
            // Wavelengths are ~0.7 m and ~1.1 m: real sand ripples are this tight, and an earlier
            // 2 m version just read as a vague swell under the grazing key rather than as sand.
            float dlRipple(vec2 p){
                float warp = dl_fbm(vec3(p * 0.09, 0.0)) * 2.6;
                float a = sin((p.x * 0.94 + p.y * 0.34) * 6.2 + warp * 3.0);
                float b = sin((p.x * -0.36 + p.y * 0.93) * 3.9 - warp * 2.0);
                return a * 0.62 + b * 0.38;
            }
            void main() {`)

        // Ripple normal. Central differences on the ripple height give a clean analytic gradient;
        // building it in world space and pushing it through viewMatrix keeps it consistent with
        // three's view-space lighting, so shadows and the low sun grazing the dunes read correctly.
        shader.fragmentShader = injectBefore(shader.fragmentShader, NORMAL_ANCHOR, /* glsl */`
        {
            vec2 p = dlWorldPos.xz;
            float e = 0.06;
            float h = dlRipple(p);
            float hx = dlRipple(p + vec2(e, 0.0));
            float hz = dlRipple(p + vec2(0.0, e));
            // Fade the ripples out with distance — beyond ~40 m they alias into moiré under the
            // grazing key, and this is also where the far dune field takes over. Amplitude is kept
            // LOW for the same reason: at 0.045 the crossed wave trains interfered into a visible
            // checkerboard wherever the view skimmed the surface.
            float fade = 1.0 - smoothstep(16.0, 42.0, length(vViewPosition));
            float amp = 0.022 * fade;
            vec3 wn = normalize(vec3(-(hx - h) / e * amp, 1.0, -(hz - h) / e * amp));
            // Blend against the real surface normal so slopes keep their shape.
            vec3 baseN = normalize(dlWorldNrm);
            wn = normalize(mix(baseN, normalize(baseN + wn - vec3(0.0, 1.0, 0.0)), fade));
            normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }
        `)

        shader.fragmentShader = injectAfter(shader.fragmentShader, SURFACE_ANCHOR, /* glsl */`
        {
            vec2 p = dlWorldPos.xz;
            float rip = dlRipple(p) * 0.5 + 0.5;
            float broad = dl_fbm(vec3(p * 0.055, 0.0));          // dune-scale value drift
            float fine  = dl_fbm(vec3(p * 0.9, 4.0));            // grain
            // Coarse gravel / exposed hardpan where the wind scours the crests.
            float gravel = smoothstep(0.62, 0.86, dl_ridge(vec3(p * 0.24, 11.0)));

            vec3 col = mix(dlSandDark, dlSandLit, clamp(0.25 + broad * 1.3 + rip * 0.28, 0.0, 1.0));
            col = mix(col, col * 0.9, fine * 0.3);
            col = mix(col, dlGravel * 1.9, gravel * 0.34);
            // Scorched, blast-darkened ground in patches — this is a fought-over depot. Kept light:
            // the sand is the only large bright surface in the frame and the thing that separates
            // dark enemy silhouettes from the background, so darkening it costs combat readability.
            col = mix(col, col * vec3(0.62, 0.58, 0.58), smoothstep(0.74, 0.96, dl_fbm(vec3(p * 0.13, 30.0))) * 0.45);
            diffuseColor.rgb = col;
            roughnessFactor = clamp(0.99 - gravel * 0.18, 0.5, 1.0);
        }
        `)

        material.userData.dlShader = shader
    }
    material.needsUpdate = true
    return material
}


// ---------------------------------------------------------------------------------------------
// Characters — player, soldiers and the beast.
//
// Strictly additive dressing: dust settling on the lower body, a touch of grime, and a RIM term.
// The rim is the important one. It is added to outgoing light AFTER shading, so it does not depend
// on the sun angle at all — which is what guarantees the brief "enemies must remain clearly
// visible in every lighting condition". A soldier standing in the deepest shadow of a container,
// backlit by a low sun, still gets a readable warm edge separating them from the background.
//
// Models, skeletons, hitboxes, animation and AI are untouched — this only ever writes to colour.
// ---------------------------------------------------------------------------------------------
export function gradeCharacter(material, opts = {}){
    const rimColor = opts.rimColor || PALETTE.sun
    const rimStrength = opts.rimStrength ?? 0.5
    const accent = opts.accent || null              // optional cyan tech accent (soldiers)
    const accentStrength = opts.accentStrength ?? 0.0
    const dustAmount = opts.dust ?? 0.5
    // World Y above which dust stops accumulating. Deliberately an absolute height rather than a
    // per-character "height above the feet": the soldiers all SHARE one material (SkeletonUtils
    // clones share materials), so there is no per-instance uniform to write to. The terrain only
    // undulates +/-1.1 m, so an absolute window puts dust on boots and shins accurately enough,
    // and it costs no per-frame work at all. Scaled up for the 2x beast.
    const dustTop = opts.dustTop ?? 1.3
    const key = opts.key || 'default'

    material.customProgramCacheKey = () => 'dl-char-' + key

    material.onBeforeCompile = (shader) => {
        addWorldVaryings(shader)
        shader.uniforms.dlRimCol = { value: rimColor.clone() }
        shader.uniforms.dlRimStr = { value: rimStrength }
        shader.uniforms.dlAccent = { value: (accent || PALETTE.techCyan).clone() }
        shader.uniforms.dlAccentStr = { value: accentStrength }
        shader.uniforms.dlDustAmt = { value: dustAmount }
        shader.uniforms.dlDustCol = { value: PALETTE.dust.clone() }
        shader.uniforms.dlDustTop = { value: dustTop }

        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            /* glsl */`
            uniform vec3 dlRimCol;
            uniform float dlRimStr;
            uniform vec3 dlAccent;
            uniform float dlAccentStr;
            uniform float dlDustAmt;
            uniform vec3 dlDustCol;
            uniform float dlDustTop;
            void main() {`)

        // Dust + grime on the albedo.
        shader.fragmentShader = injectAfter(shader.fragmentShader, SURFACE_ANCHOR, /* glsl */`
        {
            // Dust settles on boots and shins. See the dlDustTop note for why this keys off
            // absolute world height rather than height above the character's own feet.
            float low = smoothstep(dlDustTop, -0.4, dlWorldPos.y);
            float grain = dl_fbm(dlWorldPos * 9.0);
            float dusty = clamp(low * (0.55 + 0.6 * grain) * dlDustAmt, 0.0, 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, dlDustCol * 0.85, dusty * 0.5);
            // Overall grime knocks back saturation a touch so nobody reads as "clean" in this world.
            float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * 1.02, 0.16);
            // Dust where it settles, plus a roughness floor everywhere — these characters ship
            // with glossy patches, and nothing in a sand-scoured desert stays polished.
            //
            // (Worth knowing if you come here chasing the bright edge on the player's shoulder in
            // first person: that is NOT this, and not the rim below either. Measured by ablation —
            // zeroing the rim leaves it at peak 246/255, killing the key light drops it to 52. It
            // is direct sun on a shoulder facing the key, cropped into a hard streak by the
            // first-person near plane. It comes with the high-contrast key the look is built on.)
            roughnessFactor = clamp(max(roughnessFactor, 0.45) + dusty * 0.3, 0.0, 1.0);
        }
        `)

        // Rim + tech accent, added to outgoing light so they survive any lighting condition.
        shader.fragmentShader = injectBefore(shader.fragmentShader, OUTPUT_ANCHOR, /* glsl */`
        {
            vec3 V = normalize(vViewPosition);
            float fres = pow(clamp(1.0 - abs(dot(normalize(normal), V)), 0.0, 1.0), 3.0);
            outgoingLight += dlRimCol * fres * dlRimStr;
            if(dlAccentStr > 0.001){
                // Sparse cyan tech glints — gear, optics, power cells. Deliberately rare: this is
                // the world's only cool emissive and it earns its place by being scarce.
                float g = dl_fbm(dlWorldPos * 16.0 + 3.0);
                float glint = smoothstep(0.78, 0.95, g);
                outgoingLight += dlAccent * glint * dlAccentStr;
            }
        }
        `)

        material.userData.dlShader = shader
    }
    material.needsUpdate = true
    return material
}


// ---------------------------------------------------------------------------------------------
// Built structures — the NEW level geometry (castle, ruins, cover, wrecks) generated at runtime.
//
// Same weathered families as gradeStructure, with one structural difference: the journey terrain
// spans ~60 m of elevation, so "sand piles at the base" can no longer key off absolute world Y
// (that trick worked when the whole depot sat near y=0). Every generated piece instead bakes an
// `aGroundY` vertex attribute — the terrain height at the piece's own footing — and the drift is
// keyed off height ABOVE THAT, so a barricade in the basin and a parapet on the summit weather
// identically. No maps exist on these materials; relief comes from geometry + the noise field.
// ---------------------------------------------------------------------------------------------
export function gradeRuin(material, family){
    const base = { concrete: PALETTE.concrete, steel: PALETTE.steelBlack, bronze: PALETTE.bronze }[family]
    const familyId = { concrete: 0, steel: 1, bronze: 2 }[family]

    material.color.copy(base)
    material.metalness = family === 'concrete' ? 0.02 : 0.16
    material.roughness = family === 'concrete' ? 0.94 : 0.72
    material.userData.dlFamily = family
    material.customProgramCacheKey = () => 'dl-ruin-' + familyId

    material.onBeforeCompile = (shader) => {
        addWorldVaryings(shader)
        shader.uniforms.dlSand = { value: PALETTE.sandLit.clone() }
        shader.uniforms.dlRust = { value: PALETTE.rust.clone() }
        shader.uniforms.dlFamily = { value: familyId }
        shader.uniforms.dlSunDir = { value: sunDirection() }

        // Pipe the baked ground datum through to the fragment stage.
        shader.vertexShader = 'attribute float aGroundY;\nvarying float dlGroundY;\n' + shader.vertexShader
        shader.vertexShader = injectBefore(shader.vertexShader,
            ['#include <project_vertex>'], 'dlGroundY = aGroundY;')

        shader.fragmentShader = GLSL_SKY + shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            /* glsl */`
            uniform vec3 dlSand;
            uniform vec3 dlRust;
            uniform float dlFamily;
            uniform vec3 dlSunDir;
            varying float dlGroundY;
            vec3 dlSkyRefl = vec3(0.0);
            void main() {`)

        shader.fragmentShader = injectAfter(shader.fragmentShader, SURFACE_ANCHOR, /* glsl */`
        {
            vec3 wp = dlWorldPos;
            vec3 wn = normalize(dlWorldNrm);
            float up = max(wn.y, 0.0);
            float relY = wp.y - dlGroundY;          // height above this piece's own footing

            // Per-block tonal spread so a hundred merged stones don't read as one material.
            float unit = dl_fbm(floor(wp * 0.45) * 1.7 + dlFamily * 11.0);

            // Mortar-line / strata banding on the big masses — cheap "cut stone" without geometry.
            float strata = smoothstep(0.35, 0.05, abs(fract(wp.y * 0.34 + unit * 0.5) - 0.5));

            // Gravity-organised corrosion, as on the containers: per-panel blooms smeared downward.
            float panel = smoothstep(0.42, 0.80, dl_fbm(floor(wp * 0.42) * 2.3 + 17.0 + dlFamily));
            float run = dl_ridge(vec3(wp.x * 4.2, wp.y * 0.7, wp.z * 4.2) + unit * 4.0);
            float rust = smoothstep(0.50, 0.86, run) * panel;
            rust = mix(rust, rust * 0.2, step(dlFamily, 0.5));      // stone barely oxidises

            // Scorching pools low on the walls (blast + fire height).
            float scorch = smoothstep(0.55, 0.95, dl_fbm(wp * 0.55 + 21.0));
            scorch *= mix(0.3, 1.0, smoothstep(3.2, 0.2, relY));

            // Wind-piled sand at the footing + settled dust on every upward face.
            float drift = smoothstep(1.1, -0.1, relY) * (0.55 + 0.45 * dl_fbm(wp * 2.2));
            float settle = pow(up, 2.5) * (0.45 + 0.55 * dl_fbm(wp * 3.1 + 7.0))
                * smoothstep(-0.5, 1.5, relY);      // buried faces don't need the dusting
            float sand = clamp(max(drift * 1.2, settle * 0.85), 0.0, 1.0)
                * smoothstep(24.0, 8.0, relY) + pow(up, 3.0) * 0.25 * step(8.0, relY);

            vec3 col = diffuseColor.rgb;
            col *= 0.68 + 0.32 * unit;
            col = mix(col, col * 0.78, strata * 0.5);
            col = mix(col, col * vec3(0.55, 0.5, 0.48), scorch * 0.8);
            col = mix(col, dlRust, rust * 0.5);
            col = mix(col, dlSand * 0.92, clamp(sand, 0.0, 1.0) * 0.72);
            diffuseColor.rgb = col;

            roughnessFactor = clamp(mix(roughnessFactor, 0.99, max(sand, rust * 0.7)), 0.55, 1.0);
            metalnessFactor *= (1.0 - 0.85 * max(sand, rust * 0.55));

            // Same analytic sky sheen the containers carried (see gradeStructure for the why) —
            // but WEIGHTED BY UP-FACING here. At the old flat 0.20 the fresnel term washed every
            // edge-on wall with the bright horizon: a dark stone pier seen down its length turned
            // bone-pale and vanished against the sand. Walls now keep at most a whisper of sheen;
            // tops (which really do see the sky) keep more.
            vec3 Vw = normalize(cameraPosition - dlWorldPos);
            float fres = pow(clamp(1.0 - abs(dot(wn, Vw)), 0.0, 1.0), 4.0);
            vec3 refl = reflect(-Vw, wn);
            float clean = (1.0 - max(sand, rust)) * (1.0 - roughnessFactor * 0.75);
            dlSkyRefl = dl_skyColor(normalize(refl), normalize(dlSunDir)) * fres * clean * (0.04 + 0.11 * up);
        }
        `)

        shader.fragmentShader = injectBefore(shader.fragmentShader, OUTPUT_ANCHOR, /* glsl */`
        outgoingLight += dlSkyRefl;
        `)

        material.userData.dlShader = shader
    }
    material.needsUpdate = true
    return material
}


// Walk an object's materials once, applying `fn` to each unique material.
// Returns the set it touched so callers can keep per-frame uniform handles.
export function forEachMaterial(root, fn){
    const seen = new Set()
    root.traverse((node) => {
        if(!node.isMesh && !node.isSkinnedMesh){ return }
        const mats = Array.isArray(node.material) ? node.material : [node.material]
        for(const m of mats){
            if(!m || seen.has(m)){ continue }
            seen.add(m)
            fn(m, node)
        }
    })
    return seen
}
