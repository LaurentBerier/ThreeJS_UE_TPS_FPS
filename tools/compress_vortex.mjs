// Compress the Vortex Blaster GLB for shipping — step 2 of the player-weapon pipeline.
//
//   step 1 (browser):  tools/vortex_fbx_to_glb.html  loads SK_VortexBlaster.fbx (FBX 7700,
//                      which r127's runtime FBXLoader can't parse) with an r160 FBXLoader
//                      and exports SK_VortexBlaster_raw.glb (~20 MB — uncompressed 2K PNGs).
//   step 2 (this):     squeeze that raw GLB into the shipped SK_VortexBlaster.glb (~1.6 MB)
//                      using the gltf-transform CLI, staying inside what the VENDORED r127
//                      GLTFLoader can decode with NO extra decoder wiring:
//                        • textures resized to 1024² and re-encoded as WebP (EXT_texture_webp
//                          — auto-registered in the vendored loader; the normal map keeps a
//                          higher quality than the colour/emissive maps).
//                        • NO Draco / meshopt / KTX2 (those need decoders entry.js doesn't
//                          register) and NO quantize (it prunes this mesh's skin).
//
// Requires the gltf-transform CLI on PATH (npm i -g @gltf-transform/cli). Run:
//   node tools/compress_vortex.mjs
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, copyFileSync, statSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const __dir = dirname(fileURLToPath(import.meta.url));
const GUNS = join(__dir, '..', 'assets', 'guns', 'New');
const RAW = join(GUNS, 'SK_VortexBlaster_raw.glb');
const OUT = join(GUNS, 'SK_VortexBlaster.glb');

if (!existsSync(RAW)) {
  console.error('Missing', RAW);
  console.error('Produce it first with tools/vortex_fbx_to_glb.html (the r160 FBX->GLB step).');
  process.exit(1);
}

// gltf-transform resolves as a global bin; on Windows the launcher is gltf-transform.cmd.
const BIN = process.platform === 'win32' ? 'gltf-transform.cmd' : 'gltf-transform';
const gt = (...args) => execFileSync(BIN, args, { stdio: 'inherit', shell: true });

const tmp = mkdtempSync(join(tmpdir(), 'vortex-'));
const s = (n) => join(tmp, n);
try {
  gt('prune', RAW, s('a.glb'));
  gt('dedup', s('a.glb'), s('b.glb'));
  gt('resize', s('b.glb'), s('c.glb'), '--width', '1024', '--height', '1024', '--filter', 'lanczos3');
  // base color + emissive: mid quality; normal map: higher quality (JPEG-style loss hurts normals).
  gt('webp', s('c.glb'), s('d.glb'), '--slots', '!normalTexture', '--quality', '84');
  gt('webp', s('d.glb'), OUT, '--slots', 'normalTexture', '--quality', '94');
  console.log('\nWrote', OUT, '(', (statSync(OUT).size / 1e6).toFixed(2), 'MB )');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
