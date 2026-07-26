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
    // Sun / key light through late-afternoon dust. Re-graded 2026-07-24 toward the reference
    // render: GOLD, not red-orange — the previous grade sat everything a band redder than the
    // luminous honey the ref bathes in.
    sun:          new THREE.Color(0xffbe74),
    sunDeep:      new THREE.Color(0xffa04a),   // low-horizon core — hot amber
    // Sky + shadow. Re-graded 2026-07-24 toward the alien-vista reference: the zenith is now a
    // deep space indigo (dark enough to carry a starfield and the moon cluster) falling through
    // cool slate to the warm horizon band, instead of the old violet-brown cloud deck. Shadows
    // cool off further against the gold — the ref's rock shadows are steel-blue.
    skyHigh:      new THREE.Color(0x1d2336),
    skyLow:       new THREE.Color(0xeaa76b),   // luminous peach-gold horizon band
    shadowTint:   new THREE.Color(0x465878),
    // Ground bounce — a huge warm reflector under everything. (Follows the sand's 2026-07-24
    // desaturation below — bounce light is the sand's colour by definition.)
    sandBounce:   new THREE.Color(0xc7a077),
    // Ambient coming DOWN out of the sky. Not the zenith blue: at dusk a flat desert floor sees
    // mostly the warm horizon band, so a literally-blue hemisphere light desaturates the sand to
    // grey. Warmed + lifted with the 2026-07-24 grade: the ref's shadows are readable and warm,
    // not crushed.
    skyAmbient:   new THREE.Color(0x6b5e5a),
    // Surfaces. Desaturated ~35% toward pale grey-tan with the Dark Alien re-grade (2026-07-24):
    // the reference ground is cool pale rock under warm LIGHT — the gold now comes from the key
    // and the horizon, not from orange pigment in the sand. Value (luminance) deliberately
    // unchanged: the sand stays the bright surface silhouettes read against.
    sandLit:      new THREE.Color(0xccaa80),
    sandDark:     new THREE.Color(0x8a6a52),
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
    dust:         new THREE.Color(0xaf957a),
    // Very limited cyan-blue emissive technology — the ONLY cool accent in the world.
    techCyan:     new THREE.Color(0x2fd4e0),
    haze:         new THREE.Color(0xc09a70),
    // The cold layer of the alien vista: pale mist pooling at the feet of the far spires, and the
    // grey-blue moonlight family. Neither ever touches near/combat surfaces — mist lives in
    // FarWorld's distance fade, moon in the sky dome only.
    mist:         new THREE.Color(0xb4bfcc),
    moon:         new THREE.Color(0xccd4e2),
}

// Where the sun sits. Everything else in the world orients to this: the fortress is placed just
// beside it so it reads as a backlit silhouette, the cloud deck brightens toward it, the sand
// bounce comes from it, and the light shafts fan out from it.
// azimuth: compass angle in radians (0 = +X, increasing toward +Z). elevation: above the horizon.
export const SUN_AZIMUTH = THREE.MathUtils.degToRad(-118)
// The compromise the whole look balances on. Lower reads more dramatic in the sky, but the
// ground only receives sin(elevation) of the key — at 6 degrees the sand gets 10% of the sun and
// goes dead grey under ambient, losing the ochre the entire brief is built around. Raised 15→18
// with the 2026-07-24 reference grade: the ref's sun sits a touch higher, the sand takes ~20%
// more warm key (the golden wash the ref is soaked in), and shadows still run over three times
// the height of what casts them.
export const SUN_ELEVATION = THREE.MathUtils.degToRad(18)

export function sunDirection(){
    // Unit vector pointing FROM the world TOWARD the sun.
    const c = Math.cos(SUN_ELEVATION)
    return new THREE.Vector3(
        Math.cos(SUN_AZIMUTH) * c,
        Math.sin(SUN_ELEVATION),
        Math.sin(SUN_AZIMUTH) * c,
    ).normalize()
}

// THE WIND. One direction for the whole world — sand ripples, drifting motes, cloud layers,
// smoke lean and every piece of cloth all answer to this, which is what makes it read as weather
// rather than as effects. It blows FROM THE ENEMY CITADEL (2026-07-24 direction flip): the
// castle owns the sun's bearing, so a wind out of that quarter carries the whole journey's
// hostility with it — walking the trail means walking INTO the citadel's wind, and the player's
// cape billows back the moment they face their goal. The 14° skew keeps cloth from streaming
// exactly parallel to the vista camera axis (measured: an edge-on flag foreshortens to a dead
// hanging rectangle), so every banner still shows a visible cross-screen stream.
export const WIND_AZIMUTH = SUN_AZIMUTH + THREE.MathUtils.degToRad(180 - 14)
export const WIND_SPEED = 9.0      // m/s — a hard steppe wind off the citadel; gusts ride on top
export function windDirection(){
    return new THREE.Vector3(Math.cos(WIND_AZIMUTH), 0, Math.sin(WIND_AZIMUTH))
}
// Gust envelope: three incommensurate sines around a warm mean — deterministic (driven by the
// caller's clock), cheap, and it never dies to zero, so cloth keeps living between gusts.
// On top of that, BURSTS: two slow incommensurate sines only align every ~15–30 s, and raising
// their product to the 6th power turns those alignments into brief, sharp surges (~+50% for a
// couple of seconds) — the "sudden gust off the citadel" beat. One envelope for the whole world:
// flags crack, the cape snaps, the streak field flares, all in the same moment.
export function windStrengthAt(time){
    const align = Math.sin(time * 0.31) * Math.sin(time * 0.117 + 2.1)
    const burst = Math.pow(Math.max(0, align), 6.0)
    return WIND_SPEED * (0.72
        + 0.19 * Math.sin(time * 0.9)
        + 0.12 * Math.sin(time * 2.33 + 1.7)
        + 0.09 * Math.sin(time * 0.31 + 0.6)
        + 0.50 * burst)
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

    // Vertical gradient: near-black space indigo -> cool slate -> hot amber at the horizon.
    // The mid mix leans toward skyHigh (0.38, was 0.55): the reference sky stays cool almost all
    // the way down and only ignites in the last ~15 degrees above the horizon.
    vec3 zenith = ${c(PALETTE.skyHigh)} * 0.50;
    vec3 mid    = mix(${c(PALETTE.skyHigh)}, ${c(PALETTE.skyLow)}, 0.38) * 0.95;
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
    float disc = smoothstep(0.9978, 0.9992, sd);
    // Wider, softer halo than the first grade (pow 260 read as a bare bulb) — the reference sun
    // sits inside a broad gradient of glow that owns a whole quadrant of sky.
    float glow = pow(sd, 120.0) * 2.8 + pow(sd, 16.0) * 0.6;
    // Deliberately far above 1.0 so filmic tone mapping keeps a hot white core and the bloom pass
    // has something real to catch.
    return ${c(PALETTE.sunDeep)} * glow + vec3(1.0, 0.9, 0.72) * disc * 14.0;
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


// ---------------------------------------------------------------------------------------------
// CUSTOM FOG — the whole scene's aerial perspective, replacing three's flat FogExp2 mix.
//
// three's stock fog is one colour at one density: every pixel at 300 m gets the same 20% wash of
// the same beige, which is precisely why the mid-ground read as a flat cardboard cutout. This
// override (the WebGL port of the three.js webgpu_custom_fog idea: fog as a function of the
// world-space ray, not of depth alone) rebuilds the fog term per-pixel from four ingredients:
//
//   HEIGHT   — density falls off exponentially with altitude (analytic integral along the view
//              ray, so a tower fades smoothly across its own height). Basins drown, crests punch
//              through: the single biggest depth cue the flat fog was throwing away.
//   NOISE    — a wind-drifted 3D value-noise field modulates optical depth into slowly-moving
//              BANKS of haze instead of a uniform bath. Gated to zero inside 55 m so combat
//              contrast is untouchable, and weighted toward low altitude (mist pools, it does
//              not float).
//   SUN      — the fog colour warms toward the sun's quadrant (forward scattering: dusk dust is
//              brightest looking INTO the light) and cools toward PALETTE.mist for low, far
//              targets — the same altitude-pooled cold mist FarWorld's haze already speaks.
//   DISTANCE — the FogExp2 (density·metres)² curve is kept bit-compatible at mid altitude, so
//              the two fixed points the old density was tuned against still hold: <1% contrast
//              loss at 40 m (combat), and a readable castle at 600 m.
//
// It is installed by OVERRIDING three's fog ShaderChunk entries at module load, which means every
// material with fog:true — graded or stock, on meshes or points — compiles the same fog with no
// per-material wiring. The only per-material step is capturing a `fogTime` uniform handle, which
// happens automatically: a default `Material.prototype.onBeforeCompile` hook catches every stock
// material, addWorldVaryings catches every graded one, and the few bespoke onBeforeCompile sites
// (Structures' banners) call captureFogUniforms themselves. Materials that somehow skip capture
// still compile and render — their banks just don't drift (fogTime stays 0).
//
// scene.fog keeps supplying colour + density (DesertSky owns the values), so the tuning story is
// unchanged: FogExp2(haze, density) in BuildFog, everything else baked here as constants.
// ---------------------------------------------------------------------------------------------
const FOG_H0 = 6.0          // altitude (m) of reference density — roughly the basin floors
const FOG_FALLOFF = 0.028   // 1/m — density scale height ~36 m: summit air is ~5x clearer than basin air
const FOG_NOISE_M = 115.0   // metres per noise feature: banks read at vista scale, not as texture
const FOG_DRIFT_MPS = 3.2   // how fast the banks ride the world wind (slower than the gusts — mass)

const _fogUniformSets = new Set()
let _fogTime = 0
// Adds the animated-fog clock to a compiling shader and remembers the uniform set. Never cleared:
// renderer program caches outlive game restarts (scene.clear does not drop compiled materials),
// so a session-scoped registry would orphan every shared-asset material on the second run.
export function captureFogUniforms(shader){
    if(!shader || !shader.uniforms){ return }
    if(!shader.uniforms.fogTime){ shader.uniforms.fogTime = { value: _fogTime } }
    _fogUniformSets.add(shader.uniforms)
}
export function setFogTime(t){
    _fogTime = t
    for(const u of _fogUniformSets){ if(u.fogTime){ u.fogTime.value = t } }
}

{
    // Bake the direction/colour constants into the chunk source. Display-space components on
    // purpose: fog_fragment runs AFTER tone mapping + encoding in r127's fragment order, so fog
    // colours land on screen as authored — exactly how the old FogExp2 haze was tuned.
    const w = windDirection()
    const s = sunDirection()
    const v3 = (v) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`
    const c3 = (c) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
    const f1 = (x) => x.toFixed(6)
    const freq = 1 / FOG_NOISE_M

    THREE.ShaderChunk.fog_pars_vertex = /* glsl */`#ifdef USE_FOG
	varying vec3 vFogWorldPos;
#endif`
    // `transformed` is post-skinning model space in every built-in mesh/points shader, so the
    // varying is the true world position even on characters. (Sprites lack `transformed` and
    // would not compile this chunk — the game's only sprites, BloodFx droplets, are fog:false.)
    THREE.ShaderChunk.fog_vertex = /* glsl */`#ifdef USE_FOG
	vFogWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`
    THREE.ShaderChunk.fog_pars_fragment = /* glsl */`#ifdef USE_FOG
	uniform vec3 fogColor;
	uniform float fogTime;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	float fgHash(vec3 p){
		p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
		p *= 17.0;
		return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
	}
	float fgNoise(vec3 x){
		vec3 i = floor(x), f = fract(x);
		f = f * f * (3.0 - 2.0 * f);
		return mix(mix(mix(fgHash(i + vec3(0,0,0)), fgHash(i + vec3(1,0,0)), f.x),
		               mix(fgHash(i + vec3(0,1,0)), fgHash(i + vec3(1,1,0)), f.x), f.y),
		           mix(mix(fgHash(i + vec3(0,0,1)), fgHash(i + vec3(1,0,1)), f.x),
		               mix(fgHash(i + vec3(0,1,1)), fgHash(i + vec3(1,1,1)), f.x), f.y), f.z);
	}
#endif`
    THREE.ShaderChunk.fog_fragment = /* glsl */`#ifdef USE_FOG
	vec3 fgRay = vFogWorldPos - cameraPosition;
	float fgDist = max(length(fgRay), 0.001);
	vec3 fgDir = fgRay / fgDist;
	// Analytic integral of exp(-falloff*(y-H0)) along the ray, as an EFFECTIVE DISTANCE: flat
	// rays at the reference altitude integrate to exactly fgDist, so the FogExp2 curve below is
	// bit-compatible with the old flat fog at mid heights.
	float fgT = ${f1(FOG_FALLOFF)} * fgRay.y;
	float fgG = (abs(fgT) > 0.001) ? (1.0 - exp(-fgT)) / fgT : (1.0 - 0.5 * fgT);
	float fgI = fgDist * exp(-${f1(FOG_FALLOFF)} * (cameraPosition.y - ${f1(FOG_H0)})) * fgG;
	// Wind-drifted haze banks. Amplitude is zero inside 55 m (combat readability is untouchable)
	// and grows where the LOOKED-AT ground sits low — mist pools in the basins, it does not float
	// past the parapets. Two octaves; the vertical axis is compressed so banks lie flat.
	// SAMPLED AT A CAPPED MID-RAY POINT, not at the fragment: at grazing incidence over a flat
	// plain, neighbouring pixels land hundreds of metres apart, and fragment-anchored noise turns
	// into razor stripes of hot fog (measured — it read as sheets of molten water). Capping the
	// sample at 220 m along the ray bounds the field's screen-space gradient everywhere; past the
	// cap the banks become one smooth slowly-drifting modulation per view ray, which is exactly
	// how a distant bank reads anyway.
	float fgLow = smoothstep(95.0, 6.0, vFogWorldPos.y);
	vec3 fgSp = cameraPosition + fgRay * min(1.0, 220.0 / fgDist);
	vec3 fgNp = (fgSp + ${v3(w)} * (fogTime * ${f1(FOG_DRIFT_MPS)})) * vec3(${f1(freq)}, ${f1(freq * 2.6)}, ${f1(freq)});
	float fgBank = fgNoise(fgNp) * 0.65 + fgNoise(fgNp * 2.7 + 13.1) * 0.35;
	// Bank contrast raised for the cinematic re-grade (0.20/0.33 -> 0.26/0.42): the drifting
	// haze reads as distinct layered sheets of dust rather than an even wash, which is most of
	// what sells the extra atmospheric depth. Combat gate (zero inside 55 m) is untouched.
	float fgAmp = (0.26 + 0.42 * fgLow) * smoothstep(55.0, 170.0, fgDist);
	fgI *= 1.0 + (fgBank * 2.0 - 1.0) * fgAmp;
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fgI * fgI);
	#else
		float fogFactor = smoothstep(fogNear, fogFar, fgDist);
	#endif
	// Aerial colour: warm forward-scatter into the sun's quadrant, cold mist claiming whatever
	// sits low and far — the same temperature split FarWorld's haze and the reference render use.
	// The warm term is TEMPERED where the target pools low: deep mist reads cold even against
	// the light (per the reference), and untempered it painted the whole sunward basin floor as
	// glowing amber sheets.
	float fgSun = pow(clamp(dot(fgDir, ${v3(s)}) * 0.5 + 0.5, 0.0, 1.0), 5.0) * (1.0 - fgLow * 0.45);
	vec3 fgCol = mix(fogColor, ${c3(PALETTE.sunDeep)} * 1.06, fgSun * 0.62);
	// Cold pooled mist claiming the low, far ground — pushed 0.45 -> 0.55 for the cinematic
	// re-grade so the distance reads cool against the warm sky (the teal/orange split again),
	// deepening the sense of receding layers.
	fgCol = mix(fgCol, ${c3(PALETTE.mist)}, fgLow * 0.55 * (1.0 - fgSun * 0.55));
	gl_FragColor.rgb = mix(gl_FragColor.rgb, fgCol, fogFactor);
#endif`

    // Catch every STOCK material (weapons, pickups, decals, cloth, GLB props…) at compile time so
    // its fogTime uniform is registered. Graded materials assign their own onBeforeCompile and are
    // captured inside addWorldVaryings instead; bespoke sites (Structures' banner sway) call
    // captureFogUniforms explicitly. The default customProgramCacheKey is onBeforeCompile's
    // source text, identical for every material inheriting this hook — no program permutations.
    THREE.Material.prototype.onBeforeCompile = function(shader){ captureFogUniforms(shader) }
}


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
    // Every grader replaces the material's onBeforeCompile, which is what normally registers the
    // animated-fog clock — so re-register here, the one line all four graders share.
    captureFogUniforms(shader)
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
// Mean LINEAR colour of assets/World/ground_sand_D.jpg, measured over all 1024x1024 texels
// (linearise first, then average — averaging the sRGB bytes and linearising after is a different,
// wrong number for a texture with this much contrast).
//
// This exists because the photo cannot be used as a literal albedo. Its mean linear luminance is
// 0.219; the sand palette this world is balanced around sits at 0.660, and the structures at 0.16
// (see the PALETTE notes above). Dropping the photo in raw would darken the ground threefold, put
// it within a stone's throw of the containers, and break the one thing the whole look is built to
// protect: sand as the bright background that dark enemy silhouettes stay legible against.
//
// So the shader normalises the photo's LUMINANCE against this to recover a ~1.0-mean detail field
// — all of the photo's grain, crust and pebbles, none of its absolute level — and multiplies that
// onto the palette instead.
//
// SWAPPING THE TEXTURE means re-measuring this, or the ground's brightness moves with whatever the
// new image happens to average to. In a browser console, against the loaded texture:
//   const c = document.createElement('canvas'); c.width = c.height = 256
//   const x = c.getContext('2d'); x.drawImage(_APP.assets.groundTex.image, 0, 0, 256, 256)
//   const d = x.getImageData(0, 0, 256, 256).data, L = v => (v /= 255) <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4
//   let s = [0,0,0]; for(let i = 0; i < d.length; i += 4){ for(let k = 0; k < 3; k++) s[k] += L(d[i+k]) }
//   s.map(v => (v / (256*256)).toFixed(4))
const GROUND_TEX_MEAN = new THREE.Vector3(0.4737, 0.1613, 0.0393)
// How far the ground adopts the photo's own hue (0 = keep the tuned palette exactly, 1 = fully the
// photo's red-orange). Applied at CONSTANT luminance, so this knob can never affect readability.
// Dropped 0.45 -> 0.32 with the Dark Alien re-grade: the pack's grey-teal macro chroma now does
// more of the talking, and the photo supplies mostly grain.
const GROUND_TEX_HUE = 0.32
// Metres per tile. 2.6 m puts roughly a stride-and-a-half of ground across one 1024 tile, which is
// the scale the pebbles in this photo were shot at; much larger and they read as boulders.
const GROUND_TEX_TILE = 2.6

// Warm grade applied to the ground's OUTGOING LIGHT, after shading, to bring the near sand into
// agreement with the ochre of the far dune sea.
//
// It has to happen here rather than in the albedo, and the measurement is unambiguous about why.
// Sweeping GROUND_TEX_HUE across its whole range — all the way to 1.0, the photo's own chromaticity
// — moved the ground's on-screen colour from 1.202/0.967/0.730 to only 1.284/0.953/0.634, closing
// the gap to the dunes by 11%. The ground is a BRIGHT surface (screen luma 0.68) under a strong
// warm key, and ACES tone-maps bright saturated values toward white; whatever hue the albedo
// carries is washed out of it downstream. Tinting the albedo is fighting the tonemapper.
//
// So the grade goes in after the lighting sum, where it survives: applied there the same warming
// closes 37% of the gap instead of 11%.
//
// 0.40 warms the sand out of the washed-out cream it sits at unaided, without pushing it to the
// saturated orange the higher end of this knob produces. It was 0.80 briefly — chasing the closest
// possible numerical match to the far dunes — and that read as oversaturated in play: the ground
// competes with the sky rather than sitting under it. Chasing that match was the wrong target
// anyway. The dunes sit at screen luma 0.29, where a chromaticity of 2.13 is reachable; the near
// sand is a brightly lit 0.68, and at that luminance sRGB caps red chromaticity at 1/0.68 = 1.47.
// The two CANNOT converge while the sand stays bright enough to read silhouettes against, and the
// residue is aerial perspective doing its job.
// Eased 0.46 -> 0.30 for the Dark Alien ground: the pack's rock reads cool by design, and the
// full warm push was fighting the grey-blue macro layer it now sits under.
const GROUND_WARM = 0.30

// --- Dark-red ground re-grade (2026-07-25) ----------------------------------------------------
// The near ground reads as a mix of DARK RED and ALMOST BLACK, with the erosion drainage cuts
// lifted BRIGHTER so they streak across the dark surface. Applied to OUTGOING LIGHT (the only place
// colour survives ACES — see the GROUND_WARM note), and it REPLACES the warm ochre grade above.
//
// Mechanism: crush the shaded luminance toward near-black and tint it deep red; where the erosion
// 'active cut' channel (ero.R) is strong, lift the value back up toward a warmer, brighter tone so
// the streaks are the bright element the eye reads instead of the whole ground. The lit-vs-shadowed
// spread of the existing shading, multiplied by a dark factor, is what gives the dark-red -> black
// range for free. All four look values ride uniforms for live tuning.
//
// READABILITY NOTE: this deliberately abandons the old "bright sand, dark silhouettes" model (the
// ground was the bright surface enemies read against). The bright erosion streaks + the new AO pass
// now carry that separation; watch enemy legibility against the dark ground when tuning.
const GROUND_DARK = 0.22          // base outgoing-luma multiplier (lower = darker / nearer black)
const GROUND_STREAK_VAL = 0.85    // erosion-streak outgoing-luma multiplier (higher = brighter cuts)
// Streak MASK: the active-cut channel (ero.R) is remapped through smoothstep(LO, HI) so only the
// strong drainage lines lift bright — a low LO/HI would brighten the whole surface (ero.R mean ~0.20)
// and wash the dark base back out, which is exactly what an early try did.
const GROUND_STREAK_LO = 0.30     // ero.R at/below this = pure dark base (no streak)
const GROUND_STREAK_HI = 0.54     // ero.R at/above this = full streak lift
const GROUND_BASE_TINT = new THREE.Vector3(1.0, 0.16, 0.10)    // deep-red hue direction (pre-norm)
const GROUND_STREAK_TINT = new THREE.Vector3(1.0, 0.36, 0.22)  // deep-red-warm hue for the cuts (dialed back from an orange ember: too bright/warm read as glowing patches)

// --- Rugged erosion look (the "Dark Alien Landscape" bake — tools/terrain_prep) ---------------
// The geometry side of the pack lives in JourneyWorld (ENV_AMP/TRAIL_AMP); these knobs own how
// the LOOK layers read. All of them ride uniforms, so a whole tuning sweep can run against a
// single page load via material.userData.dlShader.uniforms.
const RUG_ALB_STR = 0.92     // macro luminance detail from the pack's diffuse (0 = palette only)
const RUG_HUE = 0.55         // how much of the pack's own chromaticity survives the desert grade
                             // (raised 0.38 -> 0.55 for Dark Alien: its grey-teal IS the look)
const RUG_NRM_AMP_M = 1.0    // metres of relief the residual normal map portrays at full mask
                             // (0.5 measured too soft: staining outran shading in the first pass)
const RUG_FLOW = 0.9         // drainage-wash darkening + sediment fans
const RUG_RIDGE = 0.75       // scoured-crest hardpan exposure
const RUG_AO = 1.0           // baked terrain AO on indirect light
// Erosion-REGIME layers (the ero_1024 sheet: R activity, G deposition, B varnish). These drive
// the broad luma + hue variation across the open sand — surface AGE, which the shape-driven
// layers above cannot express. Varnished flats darken and cool, active cuts pale slightly, silt
// floors go palest-warm. Bounded so sand never leaves its readability budget (see the clamp).
const RUG_ERO_LUMA = 0.55    // strength of the signed luminance drive
const RUG_ERO_HUE = 0.65     // strength of the patina/silt hue split

// rugged: { albedo, normal, ctrl, mask, meta } — world-mapped textures + the bake's meta.json.
// Optional, like tex: absent, the ground renders exactly as before.
export function gradeGround(material, tex = null, rugged = null){
    material.color.copy(PALETTE.sandLit)
    material.roughness = 0.96
    material.metalness = 0.0
    // The textures arrive as uniforms, not material.map, so they do NOT change the shader three
    // generates — but they do change the shader THIS file injects, and the variants must not
    // share a compiled program.
    material.customProgramCacheKey = () => 'dl-ground' + (tex ? '-tex' : '') + (rugged ? '-rug' : '') + (rugged && rugged.ero ? '-ero' : '')

    material.onBeforeCompile = (shader) => {
        addWorldVaryings(shader)
        shader.uniforms.dlSandLit = { value: PALETTE.sandLit.clone() }
        shader.uniforms.dlSandDark = { value: PALETTE.sandDark.clone() }
        shader.uniforms.dlGravel = { value: PALETTE.stoneDark.clone() }
        if(tex){
            shader.uniforms.dlGroundTex = { value: tex }
            shader.uniforms.dlTexMean = { value: GROUND_TEX_MEAN.clone() }
            shader.uniforms.dlTexHue = { value: GROUND_TEX_HUE }
            // Dark-red re-grade (replaces the warm ochre grade). Live-tunable.
            shader.uniforms.dlGroundDark = { value: GROUND_DARK }
            shader.uniforms.dlGroundStreakVal = { value: GROUND_STREAK_VAL }
            shader.uniforms.dlBaseTint = { value: GROUND_BASE_TINT.clone() }
            shader.uniforms.dlStreakTint = { value: GROUND_STREAK_TINT.clone() }
        }
        if(rugged){
            const meta = rugged.meta || {}
            const mean = meta.albedoMeanLinear || [0.4, 0.43, 0.39]
            const refAmp = (meta.residual && meta.residual.refAmpM) || 0.5
            shader.uniforms.dlRugAlb = { value: rugged.albedo }
            shader.uniforms.dlRugNrm = { value: rugged.normal }
            shader.uniforms.dlRugCtrl = { value: rugged.ctrl }
            shader.uniforms.dlRugMask = { value: rugged.mask }
            shader.uniforms.dlRugMean = { value: new THREE.Vector3(mean[0], mean[1], mean[2]) }
            shader.uniforms.dlRugHalf = { value: (meta.worldSize || 640) / 2 }
            shader.uniforms.dlRugSize = { value: meta.worldSize || 640 }
            shader.uniforms.dlRugNrmStr = { value: RUG_NRM_AMP_M / refAmp }
            shader.uniforms.dlRugAlbStr = { value: RUG_ALB_STR }
            shader.uniforms.dlRugHue = { value: RUG_HUE }
            shader.uniforms.dlRugFlow = { value: RUG_FLOW }
            shader.uniforms.dlRugRidge = { value: RUG_RIDGE }
            shader.uniforms.dlRugAo = { value: RUG_AO }
            if(rugged.ero){
                shader.uniforms.dlRugEro = { value: rugged.ero }
                shader.uniforms.dlRugEroLuma = { value: RUG_ERO_LUMA }
                shader.uniforms.dlRugEroHue = { value: RUG_ERO_HUE }
                shader.uniforms.dlStreakLo = { value: GROUND_STREAK_LO }
                shader.uniforms.dlStreakHi = { value: GROUND_STREAK_HI }
            }
        }

        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            /* glsl */`
            uniform vec3 dlSandLit;
            uniform vec3 dlSandDark;
            uniform vec3 dlGravel;
            ${(tex || rugged) ? /* glsl */`
            const vec3 dlLuma = vec3(0.2126, 0.7152, 0.0722);

            // Erosion-streak factor (0..1), written from the ero 'active cut' channel in the surface
            // block and read at the dark-red grade to lift the streaks brighter. Global-mutable, the
            // same carried-local pattern as dlAO. Stays 0 when the ero sheet is absent (no streaks).
            float dlStreak = 0.0;

            // Hand-rolled sRGB decode. three generates one of these automatically for material.map,
            // but these textures ride plain uniforms (the heightfield has no uv attribute), so
            // nothing upstream has decoded them.
            vec3 dlSrgbToLinear(vec3 c){
                return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
            }
            ` : ''}
            ${rugged ? /* glsl */`
            // Rugged erosion bake — one world-mapped sheet each (NOT tiled): macro albedo, the
            // sub-heightfield-grid residual normals, the flow/ridge/AO control channels, and the
            // per-cell detail-weight mask JourneyWorld recorded while compositing the geometry.
            uniform sampler2D dlRugAlb;
            uniform sampler2D dlRugNrm;
            uniform sampler2D dlRugCtrl;
            uniform sampler2D dlRugMask;
            uniform vec3 dlRugMean;
            uniform float dlRugHalf;
            uniform float dlRugSize;
            uniform float dlRugNrmStr;
            uniform float dlRugAlbStr;
            uniform float dlRugHue;
            uniform float dlRugFlow;
            uniform float dlRugRidge;
            uniform float dlRugAo;
            ${rugged.ero ? /* glsl */`
            uniform sampler2D dlRugEro;
            uniform float dlRugEroLuma;
            uniform float dlRugEroHue;
            uniform float dlStreakLo;
            uniform float dlStreakHi;
            ` : ''}
            vec2 dlRugUV(vec2 xz){ return (xz + dlRugHalf) / dlRugSize; }
            // Terrain AO rides indirect light only — written in the surface block, applied after
            // three's own aomap chunk (same carried-local pattern as gradeStructure's dlSkyRefl).
            float dlAO = 1.0;
            ` : ''}
            ${tex ? /* glsl */`
            uniform sampler2D dlGroundTex;
            uniform vec3 dlTexMean;
            uniform float dlTexHue;
            uniform float dlGroundDark;
            uniform float dlGroundStreakVal;
            uniform vec3 dlBaseTint;
            uniform vec3 dlStreakTint;

            vec3 dlTap(vec2 uv){ return dlSrgbToLinear(texture2D(dlGroundTex, uv).rgb); }

            // TRIPLANAR projection.
            //
            // Sampling on world XZ alone — which is what this did first — stretches the texture by
            // 1/cos(slope) on anything that isn't flat. That is 1.6x on the ~50 degree boss ramp and
            // worse on the dune scarps, and it reads as the ground being smeared downhill exactly
            // where the terrain silhouette is most visible. Projecting from all three axes and
            // weighting by the normal removes it: each face gets the projection that faces it.
            //
            // The two side projections are branched, not just weighted to zero, because most of a
            // heightfield on screen is flat enough to need only the Y plane. Flat ground therefore
            // pays ONE fetch here as before, and only genuinely steep pixels pay three. The weights
            // are raised to a high power first so that "flat enough" covers as much of the screen as
            // possible before the branch is taken.
            vec3 dlTriplanar(vec3 wp, vec3 n, float tile){
                vec3 w = abs(n);
                w = pow(w, vec3(6.0));
                w /= max(w.x + w.y + w.z, 1e-4);
                vec3 c = dlTap(wp.xz / tile) * w.y;
                if(w.x > 0.004){ c += dlTap(wp.zy / tile) * w.x; }
                if(w.z > 0.004){ c += dlTap(wp.xy / tile) * w.z; }
                return c;
            }

            // De-tiled albedo. One texture repeating every 2.6 m over an 800 m trek would otherwise
            // show its grid the moment the player looks down the path, and no amount of procedural
            // noise on top hides a regular grid. A second, much coarser tap at a non-integer scale
            // ratio (7.3x) and an offset breaks the period: the two only realign after hundreds of
            // metres, by which point aerial haze owns the frame anyway.
            //
            // The macro tap stays PLANAR. It is the library's "macro variation" idea — large-scale
            // colour drift — and at a 19 m repeat the stretching triplanar exists to fix is far too
            // gradual to see, so paying three fetches for it would buy nothing.
            vec3 dlGroundAlbedo(vec3 wp, vec3 n){
                vec3 a = dlTriplanar(wp, n, ${GROUND_TEX_TILE.toFixed(2)});
                vec3 b = dlTap(wp.xz / ${(GROUND_TEX_TILE * 7.3).toFixed(2)} + vec2(0.37, 0.61));
                return mix(a, b, 0.35);
            }
            ` : ''}

            // Wind-ripple field. Two crossed, noise-warped wave trains — the classic aeolian
            // pattern. Returns a height so the normal can be taken as its analytic gradient.
            // Wavelengths are ~0.7 m and ~1.1 m: real sand ripples are this tight, and an earlier
            // 2 m version just read as a vague swell under the grazing key rather than as sand.
            // Crest orientation follows THE WIND (wave vectors from WIND_AZIMUTH): the primary
            // train runs perpendicular to the wind, the secondary crosses it at ~65°, so the sand
            // agrees with the flags, smoke and drifting dust about which way the air moves.
            float dlRipple(vec2 p){
                float warp = dl_fbm(vec3(p * 0.09, 0.0)) * 2.6;
                float a = sin(dot(p, vec2(${Math.cos(WIND_AZIMUTH).toFixed(4)}, ${Math.sin(WIND_AZIMUTH).toFixed(4)})) * 6.2 + warp * 3.0);
                float b = sin(dot(p, vec2(${Math.cos(WIND_AZIMUTH + 1.13).toFixed(4)}, ${Math.sin(WIND_AZIMUTH + 1.13).toFixed(4)})) * 3.9 - warp * 2.0);
                return a * 0.62 + b * 0.38;
            }
            void main() {`)

        // Ripple normal. Central differences on the ripple height give a clean analytic gradient;
        // building it in world space and pushing it through viewMatrix keeps it consistent with
        // three's view-space lighting, so shadows and the low sun grazing the dunes read correctly.
        shader.fragmentShader = injectBefore(shader.fragmentShader, NORMAL_ANCHOR, /* glsl */`
        {
            vec2 p = dlWorldPos.xz;
            // SLOPE-SPACE normal composition. Every detail layer of a heightfield is a height
            // gradient, and gradients ADD — so instead of chaining mix/reorient hacks per layer,
            // accumulate d(h)/d(xz) from each source and rebuild one normal at the end. This is
            // the planar-projection equivalent of reoriented normal-map blending, exact for any
            // number of layers, and it is what keeps the vertex normals, the residual erosion
            // map and the wind ripples from washing each other out.
            vec3 baseN = normalize(dlWorldNrm);
            vec2 s = -baseN.xz / max(baseN.y, 0.06);
            float e = 0.06;
            float h = dlRipple(p);
            float hx = dlRipple(p + vec2(e, 0.0));
            float hz = dlRipple(p + vec2(0.0, e));
            // Fade the ripples out with distance — beyond ~40 m they alias into moiré under the
            // grazing key, and this is also where the far dune field takes over. Amplitude is kept
            // LOW for the same reason: at 0.045 the crossed wave trains interfered into a visible
            // checkerboard wherever the view skimmed the surface.
            float fade = 1.0 - smoothstep(16.0, 42.0, length(vViewPosition));
            // 0.022 predates the erosion normals; against real drainage shading the crossed sine
            // trains read as a printed checkerboard, so they drop to a supporting role.
            float amp = 0.016 * fade;
            ${rugged ? /* glsl */`
            // Aeolian ripples form in loose sand, not on the packed floors of drainage washes —
            // and killing them there is also what lets the wash lanes read as SMOOTH under the
            // grazing key, which sells the erosion more than their darkening does.
            amp *= 1.0 - smoothstep(0.22, 0.70, texture2D(dlRugCtrl, dlRugUV(p)).r) * 0.8;
            ` : ''}
            s += vec2(hx - h, hz - h) / e * amp;
            ${rugged ? /* glsl */`
            // Residual erosion normals: everything finer than the 2.5 m heightfield grid, baked
            // from the same 16-bit source the geometry detail came from. NO distance fade — this
            // is macro-anchored (one world-mapped sheet, mips handle minification), and it is
            // exactly what makes far slopes read as eroded rock instead of smooth putty. Scaled
            // by the JourneyWorld detail mask so shading never claims relief the terrain lost.
            float dlRugM = texture2D(dlRugMask, dlRugUV(p)).x;
            vec3 rn = texture2D(dlRugNrm, dlRugUV(p)).xyz * 2.0 - 1.0;
            s += -rn.xz / max(rn.y, 0.2) * (dlRugNrmStr * dlRugM);
            ` : ''}
            vec3 wn = normalize(vec3(-s.x, 1.0, -s.y));
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
            ${tex ? /* glsl */`
            {
                vec3 t = dlGroundAlbedo(dlWorldPos, normalize(dlWorldNrm));
                // Split the photo into BRIGHTNESS and HUE and recombine them against the palette
                // separately. Doing it per-channel instead (t / dlTexMean) is the obvious version
                // and it is wrong: the mean's blue is 0.039, so a near-white pebble scales blue by
                // 25x and the pebbles come out glowing cyan.
                //
                // Brightness: the photo's luminance, mean-normalised to ~1.0, so multiplying it
                // onto the palette leaves the dune-scale value drift above EXACTLY as tuned and
                // adds only grain, crust and pebble shading. Clamped because the tail of the
                // histogram is a handful of specular texels, not real albedo.
                float texLum  = max(dot(t, dlLuma), 1e-4);
                float meanLum = max(dot(dlTexMean, dlLuma), 1e-4);
                float detail  = clamp(texLum / meanLum, 0.3, 2.0);

                // Hue: unit-luminance chromaticity of each, so the blend is purely a hue rotation
                // and the ground's brightness is identical at dlTexHue 0.0 and 1.0 — which is what
                // keeps this knob from ever touching the readability budget. Using the photo's
                // PER-TEXEL chromaticity rather than its mean is what lets the dark pebbles stay
                // grey against the orange rather than being re-tinted orange along with everything.
                float baseLum = max(dot(col, dlLuma), 1e-4);
                vec3 hue = mix(col / baseLum, t / texLum, dlTexHue);

                col = hue * (baseLum * detail);
            }
            ` : ''}
            ${rugged ? /* glsl */`
            float wash = 0.0; float expo = 0.0;
            {
                // MACRO albedo from the pack's diffuse — the layer that puts sediment fans, rock
                // striations and drainage staining exactly where the normals say they should be
                // (both were baked from the same height field). Same brightness/hue split as the
                // photo detail above: luminance is mean-normalised so the tuned sand value
                // survives on average, chromaticity is adopted only partially.
                vec3 mac = dlSrgbToLinear(texture2D(dlRugAlb, dlRugUV(p)).rgb);
                float macLum = max(dot(mac, dlLuma), 1e-4);
                float macDetail = clamp(macLum / max(dot(dlRugMean, dlLuma), 1e-4), 0.3, 2.2);
                col *= mix(1.0, macDetail, dlRugAlbStr);
                // Extreme-chroma taming: the further a texel's chromaticity sits from neutral,
                // the harder it is pulled back, so what survives is tonal variation, not a biome
                // transplant. Relaxed 2.5 -> 1.6 for Dark Alien — its teal crevice staining is
                // wanted character, only the outright saturated spills still get reined in.
                vec3 macCh = mac / macLum;
                float chDist = length(macCh - vec3(1.0));
                float tameCh = 1.0 / (1.0 + chDist * chDist * 1.6);
                float mLum = max(dot(col, dlLuma), 1e-4);
                col = mix(col / mLum, macCh, dlRugHue * tameCh) * mLum;

                // Erosion control channels: R = D8 flow accumulation, G = ridge/scarp exposure,
                // B = horizon-swept AO of the shipped detail bands. Gated softly by the detail
                // mask — a wash may still cross the worn trail, but faded, and arena floors
                // stay clean for combat readability.
                vec3 ec = texture2D(dlRugCtrl, dlRugUV(p)).rgb;
                float g8 = mix(0.35, 1.0, texture2D(dlRugMask, dlRugUV(p)).x);
                ${rugged.ero ? /* glsl */`
                // Erosion REGIME sheet (surface age, baked from the same height field):
                // R = active stream-power cutting, G = silt deposition, B = varnished old flats.
                vec3 ev = texture2D(dlRugEro, dlRugUV(p)).rgb;
                ` : ''}
                // Drainage lanes: packed, darker sediment where water actually ran.
                wash = smoothstep(0.22, 0.70, ec.r) * dlRugFlow * g8;
                ${rugged.ero ? /* glsl */`
                // Where the deposition sheet says SILT settled, the lane floor is pale fines, not
                // dark packed gravel — soften the darkening there so flat outwash reads light and
                // only the steeper, still-working drainage keeps its dark floor.
                wash *= 1.0 - ev.g * 0.55;
                ` : ''}
                col = mix(col, col * vec3(0.60, 0.56, 0.53), wash * 0.65);
                // Pale deposit fans skirting the channels.
                float fan = clamp(smoothstep(0.06, 0.25, ec.r) - smoothstep(0.28, 0.75, ec.r), 0.0, 1.0) * dlRugFlow * g8;
                col = mix(col, col * vec3(1.07, 1.03, 0.97), fan * 0.30);
                // Scoured crests: hardpan exposure along the real erosion scarps. Kept visibly
                // LIGHTER than the slope-rock below — the dark full-rock read stays an honest
                // "you will slide off this" signal (thresholds match PlayerControls).
                expo = smoothstep(0.30, 0.85, ec.g) * dlRugRidge * g8;
                col = mix(col, (dlGravel * 1.7 + dlSandDark * 0.22) * 1.35, expo * 0.45);
                // Terrain AO onto indirect light only (applied after three's aomap chunk) — under
                // a 15-degree key most of the frame is lit by ambient, so this is what seats the
                // gully floors and crevices without double-darkening the sunlit faces.
                dlAO = mix(1.0, ec.b, dlRugAo * g8);
                ${rugged.ero ? /* glsl */`
                // SURFACE AGE — the erosion-regime luma/hue pass. Real desert floors carry their
                // history as tone: old undisturbed flats darken under desert varnish and gravel
                // lag, active cuts stay slightly pale, and outwash silt is the palest, warmest
                // material on the map. This is broad, low-frequency variation the per-texel macro
                // albedo cannot supply, and it is what breaks the "one sand value everywhere"
                // flatness of the open ground.
                {
                    // Patchify the varnish with the coarse noise field (~50 m breathing) so the
                    // patina reads as weather-broken fields, not a smooth airbrushed gradient.
                    float varn = ev.b * (0.55 + 0.45 * dl_fbm(vec3(p * 0.021, 53.0)));
                    // Signed luminance drive, applied multiplicatively and CLAMPED: the floor
                    // (0.68) keeps varnished flats comfortably brighter than the slope-rock's
                    // 0.42-luma "you will slide" signal, and the ceiling keeps silt lanes from
                    // blowing out under the low key.
                    // +0.146 recentres the composite to ZERO MEAN over the baked sheet (measured:
                    // act/dep/varn means 0.203/0.080/0.373) — without it the varnish term wins on
                    // average and the WHOLE floor quietly drops ~8% out of its luma budget.
                    float eLum = ev.g * 0.85 + ev.r * 0.30 - varn * 0.95 + 0.146;
                    col *= clamp(1.0 + eLum * dlRugEroLuma * g8, 0.68, 1.32);
                    // Carry the active-cut drainage streaks (ero.R) to the dark-red grade, where
                    // they are lifted bright against the crushed ground. The LO/HI remap keeps this
                    // to the strong cuts only (see the constants). Gated by the detail mask so arena
                    // floors stay clean.
                    dlStreak = smoothstep(dlStreakLo, dlStreakHi, ev.r) * g8;
                    // Hue split at near-constant value: patina pulls brown-grey (cool), silt
                    // pulls pale-warm. Multiplicative, so per-texel chroma ratios survive.
                    vec3 eHue = mix(vec3(1.0), vec3(0.90, 0.87, 0.84), clamp(varn * 1.15, 0.0, 1.0) * dlRugEroHue * g8);
                    eHue *= mix(vec3(1.0), vec3(1.05, 1.02, 0.96), clamp(ev.g * 1.25, 0.0, 1.0) * dlRugEroHue * g8);
                    col *= eHue;
                }
                ` : ''}
            }
            ` : ''}
            col = mix(col, col * 0.9, fine * 0.3);
            col = mix(col, dlGravel * 1.9, gravel * 0.34);
            // Scorched, blast-darkened ground in patches — this is a fought-over depot. Kept light:
            // the sand is the only large bright surface in the frame and the thing that separates
            // dark enemy silhouettes from the background, so darkening it costs combat readability.
            col = mix(col, col * vec3(0.62, 0.58, 0.58), smoothstep(0.74, 0.96, dl_fbm(vec3(p * 0.13, 30.0))) * 0.45);

            // SLOPE LAYER — exposed hardpan on the faces too steep to hold sand.
            //
            // This is the splatmap idea from three-landscape with the splat map deleted: on a
            // heightfield the surface normal already carries the information a hand-painted splat
            // would, and deriving the mask from it costs nothing, needs no second UV set (this mesh
            // has none at all) and cannot fall out of sync with the terrain when the layout changes.
            //
            // The thresholds are the gameplay ones, not arbitrary. PlayerControls auto-slides
            // anything past ~34 degrees and rejects uphill past ~36, so the band where rock takes
            // over is exactly the band the player cannot stand on. That makes the material read an
            // honest promise about footing: if it looks like bare rock, you will slide off it.
            //   slope = 1 - cos(angle):  34deg -> 0.17,  53deg -> 0.40
            float slope = 1.0 - clamp(normalize(dlWorldNrm).y, 0.0, 1.0);
            float rock = smoothstep(0.17, 0.40, slope);
            // Warm stone, not the cold PALETTE.stoneDark used for distant ridges: a neutral-dark
            // cliff this close reads as a hole in the frame and gives enemy silhouettes somewhere
            // to disappear into. It keeps a sand undertone so it belongs to this desert.
            //
            // Luminance ~0.38 against the sand's 0.66. That gap has to be this wide to survive the
            // tonemapper — an earlier 0.52 was only 21% down and vanished completely on any
            // sun-facing slope, where ACES pushes everything to near-white and a small albedo
            // difference simply stops existing. Affordable because the slope layer covers ~9% of
            // the terrain and only the faces too steep to stand on, so it never becomes the
            // background a silhouette has to read against.
            vec3 rockCol = dlGravel * 1.7 + dlSandDark * 0.22;
            // Broken up so the transition is a ragged scree edge rather than a clean contour band.
            float rockNoise = dl_fbm(vec3(p * 0.7, 21.0)) * 0.5 + 0.5;
            col = mix(col, rockCol * (0.75 + rockNoise * 0.5), rock * 0.80);

            diffuseColor.rgb = col;
            // Wind-packed rock scatters less than loose sand, so it comes down off the near-1.0
            // roughness the dunes sit at. Small, but it is what catches the low key along a scarp
            // edge and separates a rock face from the sand above it when both are in shadow.
            // Drainage washes pack smoother still; scoured hardpan sits between rock and sand.
            roughnessFactor = clamp(0.99 - gravel * 0.18 - rock * 0.22${rugged ? ' - wash * 0.12 - expo * 0.06' : ''}, 0.5, 1.0);
        }
        `)

        if(rugged){
            // Apply the baked terrain AO where three applies its own aoMap — to the indirect
            // terms only. The key light is left alone: sun through a crevice is the shadow map's
            // job, and multiplying direct light by AO is the classic double-darkening artefact.
            shader.fragmentShader = injectAfter(shader.fragmentShader,
                ['#include <aomap_fragment>'], /* glsl */`
            reflectedLight.indirectDiffuse *= dlAO;
            reflectedLight.indirectSpecular *= dlAO;
            `)
        }

        if(tex){
            shader.fragmentShader = injectBefore(shader.fragmentShader, OUTPUT_ANCHOR, /* glsl */`
            {
                // DARK-RED GROUND GRADE (replaces the old warm ochre grade). Colour is set on the
                // OUTGOING light because that is the only stage where it survives ACES (see the
                // GROUND_WARM note above — a bright saturated albedo just tonemaps toward white).
                //
                // VALUE: crush the shaded luminance toward near-black at the base and lift it back up
                // on the erosion streaks. The lit-vs-shadowed spread already carried in outgoingLight,
                // multiplied by this dark factor, is what produces the dark-red -> almost-black range
                // across the surface for free — lit faces land in deep red, shadow pools in near black.
                //
                // HUE: a deep-red direction for the base and a warmer, brighter ember for the streaks,
                // each renormalised to unit luminance so the tint is PURE chromaticity and the value is
                // owned solely by the term above (a saturated tint can't secretly re-brighten the base).
                float l = max(dot(outgoingLight, dlLuma), 1e-4);
                float streak = clamp(dlStreak, 0.0, 1.0);

                vec3 tint = mix(dlBaseTint, dlStreakTint, streak);
                tint /= max(dot(tint, dlLuma), 1e-4);

                float val = l * mix(dlGroundDark, dlGroundStreakVal, streak);

                outgoingLight = tint * val;
            }
            `)
        }

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
