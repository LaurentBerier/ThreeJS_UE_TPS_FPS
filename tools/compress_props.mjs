// Batch-compress the Meshy world props for shipping — the analogue of tools/compress_vortex.mjs
// but for the 20 static environment models in assets/World/meshy_batch/ (see WorldProps.js).
//
// Each raw model is ~200k–740k verts with four 2048² textures (~15–49 MB; ~600 MB total). This
// squeezes every one into a shipping GLB in assets/World/props/ that stays inside what the VENDORED
// r127 GLTFLoader decodes with NO extra wiring (EXT_texture_webp only — NO Draco/meshopt/KTX2):
//   • geometry: dedup + weld + meshopt simplify to a silhouette-preserving low-poly (~10–50k tris).
//     Simplification only reduces vertex COUNT; the output is plain float attributes, no extension.
//   • emissive: Meshy bakes emissiveFactor=[1,1,1] over a BLACK emissive map — visually nothing,
//     but a 1024² black texture would still cost ~4 MB VRAM each. Zero the factor + drop the map.
//   • textures: baseColor + normal → 1024² WebP, metallicRoughness → 512² WebP (low-freq, cheap).
// Result: ~600 MB → ~23 MB (26x), and the on-disk raw batch is .sandscapeignore'd (offline only).
//
// Unlike compress_vortex.mjs (which shells out to the gltf-transform CLI) this uses the SDK
// directly, for per-slot texture control + the emissive edit. Install the deps once, then run:
//   npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer sharp
//   node tools/compress_props.mjs [singleFile.glb]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, simplify, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { readdirSync, statSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, '..', 'assets', 'World', 'meshy_batch');
const OUT = join(__dir, '..', 'assets', 'World', 'props');
const ONLY = process.argv[2];   // optional single filename to test

await MeshoptSimplifier.ready;
mkdirSync(OUT, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const files = readdirSync(SRC).filter(f => f.toLowerCase().endsWith('.glb') && (!ONLY || f === ONLY)).sort();
let totalRaw = 0, totalOut = 0;

for (const f of files) {
  const src = join(SRC, f), out = join(OUT, f);
  const doc = await io.read(src);

  // Geometry: weld coincident verts, then meshopt-simplify. `error` is a fraction of mesh radius,
  // so it adapts per-prop; `ratio` is the floor. These props are seen at gameplay distance, so a
  // hard reduction keeps the silhouette while shedding ~95% of the triangles.
  await doc.transform(
    dedup(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.04, error: 0.01 }),
  );

  // Emissive: kill the full-white factor over the black map, then detach the (now pointless) map.
  for (const mat of doc.getRoot().listMaterials()) {
    mat.setEmissiveFactor([0, 0, 0]);
    if (mat.getEmissiveTexture()) mat.setEmissiveTexture(null);
  }

  // Textures → WebP at per-slot resolutions; prune() drops the orphaned emissive image.
  await doc.transform(
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColorTexture/, resize: [1024, 1024], quality: 82 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normalTexture/, resize: [1024, 1024], quality: 92 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /metallicRoughnessTexture/, resize: [512, 512], quality: 80 }),
    prune(),
  );

  await io.write(out, doc);
  const r = statSync(src).size, o = statSync(out).size;
  totalRaw += r; totalOut += o;
  console.log(`${f.padEnd(26)} ${(r / 1e6).toFixed(1).padStart(5)}MB -> ${(o / 1e6).toFixed(2).padStart(5)}MB`);
}
console.log(`\nTOTAL  ${(totalRaw / 1e6).toFixed(0)}MB -> ${(totalOut / 1e6).toFixed(1)}MB  (${files.length} props)`);
