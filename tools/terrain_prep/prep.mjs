// Bake a heightmap+diffuse terrain pack into the small runtime assets the journey terrain
// consumes. Current source: the "Dark Alien Landscape" pack (2048² 16-bit grayscale height PNG +
// 16-bit RGB diffuse — grey-blue eroded alien rock). Previously: "Rugged Terrain with Rivers"
// (Motion Forge, CC0, 4096² 16-bit RGB). Offline, run once (re-run only to retune):
//
//   node tools/terrain_prep/prep.mjs
//
// The game's terrain is authored math (JourneyWorld.HeightOf) at 2.5 m cells — the layout must not
// change, so the pack is split by FREQUENCY BAND against that grid (the nathanpointer.com/landscapes
// split: geometry carries only what the grid can hold; everything finer lives in normal/albedo maps):
//
//   detail_257.f32   geometry band: what the 257² heightfield CAN represent minus the pack's own
//                    macro shape (its central massif would fight the authored castle/basin layout).
//                    Normalised ±1; JourneyWorld composites it into the environment term in metres.
//   normal_4096.webp residual band: everything FINER than the heightfield grid, baked as a
//                    world-XZ-projected normal map (+X = +x, +Y = up, +Z = +z, rows = increasing z).
//                    This is where the erosion channels/gully texture actually read from.
//   ctrl_1024.webp   erosion control: R = D8 flow accumulation (drainage/river lines, from the FULL
//                    band so channels follow real dendritic paths), G = ridge/scarp exposure,
//                    B = ambient occlusion of the shipped detail bands (horizon-swept).
//   albedo_2048.webp the pack's diffuse, downsampled. Macro colour variation; the desert hue grade
//                    happens in-shader (DesertLook) so the palette stays tunable at runtime.
//   meta.json        baked reference scales the runtime needs to interpret the above.
//
// Everything is oriented row j -> world z = -half + (j/(N-1))*size, col i -> world x likewise, i.e.
// THE SAME row-major convention as JourneyWorld.BuildHeights. Textures must be sampled with
// flipY = false and uv = (world.xz + half) / size.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { inflateSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.argv[2] || 'C:/Users/lbernier/Downloads/Dark Alien Landscape Height Map';
const SRC_HEIGHT = join(SRC_DIR, 'Height Map.png');
const SRC_DIFFUSE = join(SRC_DIR, 'Diffuse Map.png');
const OUT_DIR = join(__dir, '..', '..', 'assets', 'World', 'rugged');
mkdirSync(OUT_DIR, { recursive: true });

const WORLD_SIZE = 640;          // metres — must match JourneyWorld.WORLD.size
const GRID_N = 257;              // must match JourneyWorld.WORLD.gridN (2.5 m cells)
// Fraction of the source map (centred) laid over the world. 1.0 spreads the full source across
// 640 m and the erosion features read miniature — "too much detail for the scale". 0.625 uses
// the central window, making every feature 1.6× larger in metres. All bands (geometry, normals,
// flow, albedo) crop together, so they stay mutually registered.
const CROP = 0.625;
const MACRO_N = 17;              // the pack's own macro shape (≈40 m/sample) — removed everywhere
const NORMAL_N = 2048;           // residual normal map resolution. Source-limited: the Dark Alien
                                 // pack is 2048² (1280² after crop), so a 4096 sheet would hold
                                 // upsample blur, cost 4× the VRAM and sharpen nothing.
const CTRL_N = 1024;             // flow/ridge/AO resolution (0.625 m/texel)
const ALBEDO_N = 2048;
const RESIDUAL_REF_M = 0.5;      // metres of relief the residual's ±1 maps to IN THE BAKE — the
                                 // shader rescales n.xy by (runtime amp / this) * detail mask.

// ---------------------------------------------------------------------------------------------
// 16-bit PNG decode, by hand. sharp's raw({depth:'ushort'}) path was measured returning 8-bit
// values (val>>8) on this file, so the one decode where precision matters is done from spec:
// concat IDAT -> inflate -> per-row unfilter -> big-endian first channel. Handles 16-bit
// grayscale (color type 0, bpp 2 — the Dark Alien pack) and 16-bit RGB (type 2, bpp 6).
// ---------------------------------------------------------------------------------------------
function decodePng16Gray(path){
    const buf = readFileSync(path);
    if(buf.readUInt32BE(0) !== 0x89504e47){ throw new Error('not a PNG'); }
    let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while(off < buf.length){
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if(type === 'IHDR'){
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9]; interlace = data[12];
        }else if(type === 'IDAT'){ idat.push(data); }
        else if(type === 'IEND'){ break; }
        off += 12 + len;
    }
    if(bitDepth !== 16 || (colorType !== 2 && colorType !== 0) || interlace !== 0){
        throw new Error(`unsupported PNG layout: depth ${bitDepth} color ${colorType} interlace ${interlace}`);
    }
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colorType === 2 ? 6 : 2;  // channels × 2 bytes
    const stride = w * bpp;
    const out = new Float32Array(w * h);
    const prev = new Uint8Array(stride);  // previous row, unfiltered
    const row = new Uint8Array(stride);
    for(let y = 0; y < h; y++){
        const filter = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        if(filter === 0){ row.set(src); }
        else if(filter === 1){       // Sub
            for(let x = 0; x < stride; x++){ row[x] = (src[x] + (x >= bpp ? row[x - bpp] : 0)) & 255; }
        }else if(filter === 2){      // Up
            for(let x = 0; x < stride; x++){ row[x] = (src[x] + prev[x]) & 255; }
        }else if(filter === 3){      // Average
            for(let x = 0; x < stride; x++){
                const a = x >= bpp ? row[x - bpp] : 0;
                row[x] = (src[x] + ((a + prev[x]) >> 1)) & 255;
            }
        }else if(filter === 4){      // Paeth
            for(let x = 0; x < stride; x++){
                const a = x >= bpp ? row[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                row[x] = (src[x] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
            }
        }else{ throw new Error('bad filter ' + filter); }
        for(let x = 0; x < w; x++){ out[y * w + x] = ((row[x * bpp] << 8) | row[x * bpp + 1]) / 65535; }
        prev.set(row);
    }
    return { data: out, w, h };
}

// ---------------------------------------------------------------------------------------------
// Float-array resampling (square, single channel). Area-average downsample = clean band-limit;
// Catmull-Rom bicubic upsample = C1-smooth, no piecewise-linear creases (a bilinear upsample of
// the macro band would print its grid straight into the geometry and the normal map).
// ---------------------------------------------------------------------------------------------
function resample1D(src, sN, dN, rowStride, rowCount, dstStride){
    // Resamples along the "stride" axis: src rows of sN entries (stride rowStride between rows).
    const dst = new Float32Array(dN * rowCount);
    const r = sN / dN;
    for(let y = 0; y < rowCount; y++){
        const so = y * rowStride, dof = y * dstStride;
        for(let d = 0; d < dN; d++){
            const a = d * r, b = a + r;
            const i0 = Math.floor(a), i1 = Math.min(sN - 1, Math.ceil(b) - 1);
            let sum = 0, wsum = 0;
            for(let i = i0; i <= i1; i++){
                const w = Math.min(b, i + 1) - Math.max(a, i);
                sum += src[so + i] * w; wsum += w;
            }
            dst[dof + d] = sum / wsum;
        }
    }
    return dst;
}
function downsampleArea(src, sN, dN){
    const rows = resample1D(src, sN, dN, sN, sN, dN);            // shrink X: sN×sN -> dN wide, sN rows
    // shrink Y: operate on columns by resampling the transposed view
    const t = new Float32Array(sN * dN);
    for(let y = 0; y < sN; y++){ for(let x = 0; x < dN; x++){ t[x * sN + y] = rows[y * dN + x]; } }
    const cols = resample1D(t, sN, dN, sN, dN, dN);              // dN columns of dN
    const out = new Float32Array(dN * dN);
    for(let x = 0; x < dN; x++){ for(let y = 0; y < dN; y++){ out[y * dN + x] = cols[x * dN + y]; } }
    return out;
}
function catrom(t, p0, p1, p2, p3){
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}
function upsampleBicubic(src, sN, dN){
    const out = new Float32Array(dN * dN);
    const cl = (v) => Math.max(0, Math.min(sN - 1, v));
    const scale = sN / dN;
    // separable: rows first into a dN×sN buffer, then columns
    const mid = new Float32Array(dN * sN);
    for(let y = 0; y < sN; y++){
        for(let d = 0; d < dN; d++){
            const s = (d + 0.5) * scale - 0.5;
            const i = Math.floor(s), t = s - i;
            const o = y * sN;
            mid[y * dN + d] = catrom(t, src[o + cl(i - 1)], src[o + cl(i)], src[o + cl(i + 1)], src[o + cl(i + 2)]);
        }
    }
    for(let d = 0; d < dN; d++){
        for(let dy = 0; dy < dN; dy++){
            const s = (dy + 0.5) * scale - 0.5;
            const j = Math.floor(s), t = s - j;
            out[dy * dN + d] = catrom(t, mid[cl(j - 1) * dN + d], mid[cl(j) * dN + d], mid[cl(j + 1) * dN + d], mid[cl(j + 2) * dN + d]);
        }
    }
    return out;
}
function gaussBlur(src, N, sigma){
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(radius * 2 + 1);
    let ks = 0;
    for(let i = -radius; i <= radius; i++){ const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + radius] = v; ks += v; }
    for(let i = 0; i < k.length; i++){ k[i] /= ks; }
    const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
    const cl = (v) => Math.max(0, Math.min(N - 1, v));
    for(let y = 0; y < N; y++){ for(let x = 0; x < N; x++){
        let s = 0; for(let i = -radius; i <= radius; i++){ s += src[y * N + cl(x + i)] * k[i + radius]; }
        tmp[y * N + x] = s;
    } }
    for(let y = 0; y < N; y++){ for(let x = 0; x < N; x++){
        let s = 0; for(let i = -radius; i <= radius; i++){ s += tmp[cl(y + i) * N + x] * k[i + radius]; }
        out[y * N + x] = s;
    } }
    return out;
}
function percentileAbs(arr, p){
    // robust scale from a stride sample (full sort of 16M floats is wasteful)
    const step = Math.max(1, Math.floor(arr.length / 1_000_000));
    const s = [];
    for(let i = 0; i < arr.length; i += step){ s.push(Math.abs(arr[i])); }
    s.sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// ---------------------------------------------------------------------------------------------
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, m);

say('decoding 16-bit height map…');
const dec = decodePng16Gray(SRC_HEIGHT);
// Centre crop (see CROP above). Done immediately after decode so every derived product — the
// geometry band, the residual normals, flow, AO and the diffuse — sees the same source window.
const SN = Math.round(dec.w * CROP);
const OFF = Math.floor((dec.w - SN) / 2);
const H = new Float32Array(SN * SN);
for(let y = 0; y < SN; y++){
    for(let x = 0; x < SN; x++){ H[y * SN + x] = dec.data[(y + OFF) * dec.w + (x + OFF)]; }
}
say(`decoded ${dec.w}² -> centre crop ${SN}² (features ×${(1 / CROP).toFixed(2)}) — range check…`);
{
    let mn = 1, mx = 0;
    for(let i = 0; i < H.length; i += 97){ const v = H[i]; if(v < mn) mn = v; if(v > mx) mx = v; }
    say(`height ∈ [${mn.toFixed(4)}, ${mx.toFixed(4)}] (16-bit levels ≈ ${Math.round((mx - mn) * 65535)})`);
    if((mx - mn) * 65535 < 1000){ throw new Error('height range suspiciously small — decode wrong?'); }
}

// --- geometry band ---------------------------------------------------------------------------
say('geometry band…');
const g257 = downsampleArea(H, SN, GRID_N);
const g17 = downsampleArea(H, SN, MACRO_N);
const macro257 = upsampleBicubic(g17, MACRO_N, GRID_N);
const geo = new Float32Array(GRID_N * GRID_N);
for(let i = 0; i < geo.length; i++){ geo[i] = g257[i] - macro257[i]; }
const sGeo = percentileAbs(geo, 0.995);
for(let i = 0; i < geo.length; i++){ geo[i] = Math.max(-1, Math.min(1, geo[i] / sGeo)); }
writeFileSync(join(OUT_DIR, 'detail_257.f32'), Buffer.from(geo.buffer));
say(`detail_257.f32 written (±1 = ${sGeo.toFixed(5)} of the map's 0..1 range)`);

// --- residual band + normals -----------------------------------------------------------------
say('residual band…');
const up257 = upsampleBicubic(g257, GRID_N, SN);
const R = new Float32Array(SN * SN);
for(let i = 0; i < R.length; i++){ R[i] = H[i] - up257[i]; }
const sRes = percentileAbs(R, 0.995);
say(`residual robust scale ${sRes.toExponential(3)}`);
// With the crop the source can sit BELOW the normal-map resolution — box "downsampling" upward
// would go blocky, so pick the resampler by direction.
const Rn = SN >= NORMAL_N ? downsampleArea(R, SN, NORMAL_N) : upsampleBicubic(R, SN, NORMAL_N);
const texelM = WORLD_SIZE / NORMAL_N;
const nrm = new Uint8Array(NORMAL_N * NORMAL_N * 3);
{
    const cl = (v) => Math.max(0, Math.min(NORMAL_N - 1, v));
    for(let y = 0; y < NORMAL_N; y++){
        for(let x = 0; x < NORMAL_N; x++){
            const hC = (i, j) => Math.max(-1, Math.min(1, Rn[cl(j) * NORMAL_N + cl(i)] / sRes)) * RESIDUAL_REF_M;
            const dhdx = (hC(x + 1, y) - hC(x - 1, y)) / (2 * texelM);
            const dhdz = (hC(x, y + 1) - hC(x, y - 1)) / (2 * texelM);
            const inv = 1 / Math.hypot(dhdx, 1, dhdz);
            const o = (y * NORMAL_N + x) * 3;
            nrm[o]     = Math.round((-dhdx * inv * 0.5 + 0.5) * 255);
            nrm[o + 1] = Math.round((1 * inv * 0.5 + 0.5) * 255);
            nrm[o + 2] = Math.round((-dhdz * inv * 0.5 + 0.5) * 255);
        }
    }
}
await sharp(Buffer.from(nrm), { raw: { width: NORMAL_N, height: NORMAL_N, channels: 3 } })
    .webp({ quality: 94 }).toFile(join(OUT_DIR, `normal_${NORMAL_N}.webp`));
say(`normal_${NORMAL_N}.webp written`);

// --- control maps ----------------------------------------------------------------------------
say('control maps…');
const g1024 = downsampleArea(H, SN, CTRL_N);
const macro1024 = upsampleBicubic(g17, MACRO_N, CTRL_N);

// D8 flow accumulation over the FULL band — drainage must follow the real (macro) valleys or the
// river lines end up contour-agnostic. Sorted descending, each cell pours its accumulation into
// its steepest strictly-lower neighbour.
say('  flow accumulation…');
const acc = new Float32Array(CTRL_N * CTRL_N).fill(1);
{
    const idx = new Uint32Array(CTRL_N * CTRL_N);
    for(let i = 0; i < idx.length; i++){ idx[i] = i; }
    // sort by height descending (typed-array sort on a copy of keys)
    const keys = Array.from(idx);
    keys.sort((a, b) => g1024[b] - g1024[a]);
    const NB = [[-1,-1,Math.SQRT1_2],[0,-1,1],[1,-1,Math.SQRT1_2],[-1,0,1],[1,0,1],[-1,1,Math.SQRT1_2],[0,1,1],[1,1,Math.SQRT1_2]];
    for(const i of keys){
        const x = i % CTRL_N, y = (i / CTRL_N) | 0, h0 = g1024[i];
        let best = -1, bestS = 0;
        for(const [dx, dy, w] of NB){
            const nx = x + dx, ny = y + dy;
            if(nx < 0 || ny < 0 || nx >= CTRL_N || ny >= CTRL_N){ continue; }
            const s = (h0 - g1024[ny * CTRL_N + nx]) * w;
            if(s > bestS){ bestS = s; best = ny * CTRL_N + nx; }
        }
        if(best >= 0){ acc[best] += acc[i]; }
    }
}
let flow = new Float32Array(CTRL_N * CTRL_N);
{
    // log-compress; robust-normalise so the big trunk rivers don't own the whole range
    for(let i = 0; i < flow.length; i++){ flow[i] = Math.log1p(acc[i]); }
    const lo = Math.log1p(4);            // below ~4 upstream cells: not a channel
    let hi = 0;
    const s = [];
    for(let i = 0; i < flow.length; i += 17){ s.push(flow[i]); }
    s.sort((a, b) => a - b);
    hi = s[Math.floor(s.length * 0.999)];
    for(let i = 0; i < flow.length; i++){ flow[i] = Math.max(0, Math.min(1, (flow[i] - lo) / (hi - lo))); }
    flow = gaussBlur(flow, CTRL_N, 1.0);   // widen hairline channels ~a texel
}

// ridge / scarp exposure: what stands PROUD of the ~6 m neighbourhood
say('  ridge exposure…');
const ridge = new Float32Array(CTRL_N * CTRL_N);
{
    const blur = gaussBlur(g1024, CTRL_N, 9.6);    // σ 9.6 texels ≈ 6 m
    for(let i = 0; i < ridge.length; i++){ ridge[i] = g1024[i] - blur[i]; }
    const s = percentileAbs(ridge, 0.99);
    for(let i = 0; i < ridge.length; i++){ ridge[i] = Math.max(0, Math.min(1, ridge[i] / s)); }
}

// AO of the DETAIL bands only (macro removed — the runtime terrain doesn't ship the massif, so its
// shadowing would be false). Horizon-swept, 8 directions, 25 m radius.
say('  ambient occlusion…');
const ao = new Float32Array(CTRL_N * CTRL_N).fill(0);
{
    const GEO_AMP_ASSUMED = 3.2;   // metres — matches JourneyWorld's ENV_AMP
    const hM = new Float32Array(CTRL_N * CTRL_N);
    for(let i = 0; i < hM.length; i++){
        hM[i] = Math.max(-1, Math.min(1, (g1024[i] - macro1024[i]) / sGeo)) * GEO_AMP_ASSUMED;
    }
    const texel = WORLD_SIZE / CTRL_N;   // 0.625 m
    const R_STEPS = 56;                  // 35 m
    const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for(let y = 0; y < CTRL_N; y++){
        for(let x = 0; x < CTRL_N; x++){
            const h0 = hM[y * CTRL_N + x];
            let occ = 0;
            for(const [dx, dy] of DIRS){
                const stepLen = Math.hypot(dx, dy) * texel;
                let maxTan = 0;
                for(let t = 1; t <= R_STEPS; t++){
                    const nx = x + dx * t, ny = y + dy * t;
                    if(nx < 0 || ny < 0 || nx >= CTRL_N || ny >= CTRL_N){ break; }
                    const tan = (hM[ny * CTRL_N + nx] - h0) / (stepLen * t);
                    if(tan > maxTan){ maxTan = tan; }
                }
                occ += maxTan / (1 + maxTan);    // 0..1 as slope -> vertical
            }
            // Shaped (gamma > 1) so open ground stays untouched while gully floors and the feet
            // of scarps actually darken — the flat bake read as no-op in the first screenshots.
            ao[y * CTRL_N + x] = Math.pow(1 - Math.min(1, (occ / DIRS.length) * 2.2), 1.6);
        }
    }
}

const ctrl = new Uint8Array(CTRL_N * CTRL_N * 3);
for(let i = 0; i < CTRL_N * CTRL_N; i++){
    ctrl[i * 3]     = Math.round(flow[i] * 255);
    ctrl[i * 3 + 1] = Math.round(ridge[i] * 255);
    ctrl[i * 3 + 2] = Math.round(ao[i] * 255);
}
await sharp(Buffer.from(ctrl), { raw: { width: CTRL_N, height: CTRL_N, channels: 3 } })
    .webp({ lossless: true }).toFile(join(OUT_DIR, 'ctrl_1024.webp'));
say('ctrl_1024.webp written');

// --- erosion-luma sheet ------------------------------------------------------------------------
// A second control sheet, derived from the same height field, that classifies every texel by its
// EROSION REGIME rather than by its shape. The runtime uses it to drive broad luminance + hue
// variation across the sand (DesertLook's RUG_ERO_* knobs) — the "which surfaces are old, which
// are freshly worked by water" read that real desert floors carry and flat procedural noise
// cannot fake:
//   R  activity — stream-power erosion (flow × slope): channel walls and headcuts being actively
//                 cut. Reads as freshly-scoured, slightly pale ground.
//   G  deposition — where the water that carried sediment slows down (high flow, low slope):
//                 outwash fans and basin silt. Reads as the palest, finest material.
//   B  varnish  — long-undisturbed surfaces (neither eroding nor receiving): old flats between
//                 drainages. Desert varnish / gravel lag patina — the DARK, slightly cool member
//                 that gives the floor its tonal age range.
// All three are ROBUST-normalised fields, not physical quantities — the shader treats them as
// weights.
say('erosion regime sheet…');
{
    // Slope magnitude per texel (normalised — only the relative field matters).
    const slope = new Float32Array(CTRL_N * CTRL_N);
    {
        const cl = (v) => Math.max(0, Math.min(CTRL_N - 1, v));
        for(let y = 0; y < CTRL_N; y++){
            for(let x = 0; x < CTRL_N; x++){
                const dx = g1024[y * CTRL_N + cl(x + 1)] - g1024[y * CTRL_N + cl(x - 1)];
                const dy = g1024[cl(y + 1) * CTRL_N + x] - g1024[cl(y - 1) * CTRL_N + x];
                slope[y * CTRL_N + x] = Math.hypot(dx, dy);
            }
        }
        const s = percentileAbs(slope, 0.90);
        for(let i = 0; i < slope.length; i++){ slope[i] = Math.min(1, slope[i] / (s * 2)); }
    }

    // Activity: stream power ~ flow^a × slope^b. The exponents flatten the flow's huge dynamic
    // range so tributary walls register, not just the trunk channels.
    const act = new Float32Array(CTRL_N * CTRL_N);
    for(let i = 0; i < act.length; i++){
        act[i] = Math.pow(flow[i], 0.55) * Math.pow(slope[i], 0.85);
    }
    {
        const s = percentileAbs(act, 0.99) || 1;
        for(let i = 0; i < act.length; i++){ act[i] = Math.min(1, act[i] / s); }
    }

    // Deposition: carried sediment drops where flow is still high but the ground flattens out.
    const dep = new Float32Array(CTRL_N * CTRL_N);
    for(let i = 0; i < dep.length; i++){
        const f = Math.max(0, Math.min(1, (flow[i] - 0.08) / 0.45));         // needs real drainage
        const flat = Math.pow(Math.max(0, 1 - slope[i] * 1.9), 2.2);          // …that has slowed down
        dep[i] = f * flat;
    }
    {
        const s = percentileAbs(dep, 0.99) || 1;
        for(let i = 0; i < dep.length; i++){ dep[i] = Math.min(1, dep[i] / s); }
    }

    // Varnish: whatever the drainage system leaves alone, smoothed so it reads as broad patina
    // fields rather than a per-texel inverse of the other two.
    let varn = new Float32Array(CTRL_N * CTRL_N);
    for(let i = 0; i < varn.length; i++){
        varn[i] = Math.max(0, Math.min(1, 1 - act[i] * 2.6 - dep[i] * 1.9));
    }
    varn = gaussBlur(varn, CTRL_N, 5);
    {
        // Spread: after the blur the field bunches high — re-stretch so mid-tones exist.
        let lo = 1, hi = 0;
        for(let i = 0; i < varn.length; i += 13){ const v = varn[i]; if(v < lo) lo = v; if(v > hi) hi = v; }
        const r = Math.max(1e-4, hi - lo);
        for(let i = 0; i < varn.length; i++){ varn[i] = Math.pow(Math.max(0, Math.min(1, (varn[i] - lo) / r)), 1.35); }
    }

    const ero = new Uint8Array(CTRL_N * CTRL_N * 3);
    for(let i = 0; i < CTRL_N * CTRL_N; i++){
        ero[i * 3]     = Math.round(act[i] * 255);
        ero[i * 3 + 1] = Math.round(dep[i] * 255);
        ero[i * 3 + 2] = Math.round(varn[i] * 255);
    }
    await sharp(Buffer.from(ero), { raw: { width: CTRL_N, height: CTRL_N, channels: 3 } })
        .webp({ lossless: true }).toFile(join(OUT_DIR, 'ero_1024.webp'));
    say('ero_1024.webp written');
    await (async () => {
        const prev = async (name, arr) => {
            const g = new Uint8Array(CTRL_N * CTRL_N);
            for(let i = 0; i < g.length; i++){ g[i] = Math.round(Math.max(0, Math.min(1, arr[i])) * 255); }
            await sharp(Buffer.from(g), { raw: { width: CTRL_N, height: CTRL_N, channels: 1 } }).png().toFile(join(__dir, name));
        };
        await prev('preview_ero_act.png', act);
        await prev('preview_ero_dep.png', dep);
        await prev('preview_ero_varnish.png', varn);
    })();
}

// --- albedo ----------------------------------------------------------------------------------
say('albedo…');
await sharp(SRC_DIFFUSE, { limitInputPixels: false })
    .extract({ left: OFF, top: OFF, width: SN, height: SN })   // same window as the height crop
    .resize(ALBEDO_N, ALBEDO_N, { kernel: 'lanczos3' })
    .webp({ quality: 85 }).toFile(join(OUT_DIR, 'albedo_2048.webp'));
// mean LINEAR colour of the shipped albedo (same convention as GROUND_TEX_MEAN — linearise first,
// then average) so the shader can mean-normalise its luminance
const albRaw = await sharp(join(OUT_DIR, 'albedo_2048.webp')).raw().toBuffer();
const mean = [0, 0, 0];
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
for(let i = 0; i < ALBEDO_N * ALBEDO_N; i++){
    mean[0] += toLin(albRaw[i * 3]); mean[1] += toLin(albRaw[i * 3 + 1]); mean[2] += toLin(albRaw[i * 3 + 2]);
}
for(let k = 0; k < 3; k++){ mean[k] /= ALBEDO_N * ALBEDO_N; }
say(`albedo_2048.webp written — mean linear [${mean.map(v => v.toFixed(4)).join(', ')}]`);

// --- meta + debug previews -------------------------------------------------------------------
writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify({
    worldSize: WORLD_SIZE,
    gridN: GRID_N,
    detail: { file: 'detail_257.f32', n: GRID_N, format: 'float32-le', normalized: true },
    residual: { refAmpM: RESIDUAL_REF_M },
    ero: { file: 'ero_1024.webp', channels: 'R=stream-power activity, G=deposition, B=varnish/age' },
    albedoMeanLinear: mean.map(v => +v.toFixed(5)),
    convention: 'row j -> z=-half+(j/(N-1))*size, col i -> x likewise; sample textures with flipY=false, uv=(xz+half)/size',
}, null, 2));

// grayscale previews so the bands can be eyeballed without the game
const prev = async (name, arr, N, signed) => {
    const g = new Uint8Array(N * N);
    for(let i = 0; i < g.length; i++){ g[i] = Math.round(Math.max(0, Math.min(1, signed ? arr[i] * 0.5 + 0.5 : arr[i])) * 255); }
    await sharp(Buffer.from(g), { raw: { width: N, height: N, channels: 1 } }).png().toFile(join(__dir, name));
};
await prev('preview_geo.png', geo, GRID_N, true);
await prev('preview_flow.png', flow, CTRL_N, false);
await prev('preview_ridge.png', ridge, CTRL_N, false);
await prev('preview_ao.png', ao, CTRL_N, false);
say('done — previews in tools/terrain_prep/, runtime assets in assets/World/rugged/');
