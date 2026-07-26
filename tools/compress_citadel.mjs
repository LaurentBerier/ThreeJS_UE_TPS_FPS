// Compress the summit Citadel model (assets/World/Citadel_0723213948_texture.glb, ~15 MB) into the
// shipping assets/World/props/Citadel.glb (~1.2 MB) used by WorldProps._citadel to replace the old
// procedural keep/towers. Unlike the 20 batch props (tools/compress_props.mjs) this model is ALREADY
// low-poly (~7k tris) — it is a hero backdrop seen from the summit arena, so DON'T simplify it; only
// clean up and WebP the four 2048² textures (baseColor/normal 1024², metalRough 512²) and drop the
// black emissive map. r127-safe (EXT_texture_webp only). Deps as in compress_props.mjs. Run:
//   node tools/compress_citadel.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, '..', 'assets', 'World', 'Citadel_0723213948_texture.glb');
const OUT = join(__dir, '..', 'assets', 'World', 'props', 'Citadel.glb');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);

for (const mat of doc.getRoot().listMaterials()) {
  mat.setEmissiveFactor([0, 0, 0]);
  if (mat.getEmissiveTexture()) mat.setEmissiveTexture(null);
}
await doc.transform(
  dedup(), weld(), prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColorTexture/, resize: [1024, 1024], quality: 86 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normalTexture/, resize: [1024, 1024], quality: 92 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /metallicRoughnessTexture/, resize: [512, 512], quality: 82 }),
  prune(),
);
await io.write(OUT, doc);
console.log('wrote', OUT, (statSync(OUT).size / 1e6).toFixed(2), 'MB (from', (statSync(SRC).size / 1e6).toFixed(1), 'MB)');
