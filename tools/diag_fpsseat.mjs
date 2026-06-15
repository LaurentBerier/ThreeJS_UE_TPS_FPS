// Extract the FPS gun's CAMERA-LOCAL pose (position + orientation-as-Euler-deg) for hip and ADS, at a clean
// standing LEVEL pose. These become the deterministic camera-local viewmodel constants (replacing the
// non-deterministic per-spawn calibration). Reads the live (calibrated) gun at spawn, where pitch~0.
//   node tools/diag_fpsseat.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import os from 'os';
import http from 'http';
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.fbx': 'application/octet-stream', '.obj': 'text/plain', '.wav': 'audio/wav', '.tga': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' }); res.end(readFileSync(fpath));
});
const PORT = 8103;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=/tmp/diagseat-chrome', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    window.__pc = () => window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    window.__body = () => window._APP.entityManager.Get('Player').GetComponent('PlayerBody');
    window.__seat = () => {
      const body = window.__body(); const pc = window.__pc(); const cam = pc.camera;
      cam.updateMatrixWorld(); body.model.updateMatrixWorld(true);
      const gunW = body.weaponPivot.getWorldPosition(new cam.position.constructor());
      const gunQ = new cam.quaternion.constructor(); body.weaponPivot.getWorldQuaternion(gunQ);
      // camera-local position
      const pos = gunW.clone().applyMatrix4(cam.matrixWorldInverse);
      // camera-local quaternion = camQ^-1 * gunQ ; to Euler XYZ deg
      const camInv = cam.quaternion.clone().invert();
      const ql = camInv.multiply(gunQ);
      const eul = window.__eulFromQuat(ql);
      const r2d = 180 / Math.PI;
      return { px: +pos.x.toFixed(4), py: +pos.y.toFixed(4), pz: +pos.z.toFixed(4),
               rx: +(eul.x * r2d).toFixed(2), ry: +(eul.y * r2d).toFixed(2), rz: +(eul.z * r2d).toFixed(2),
               pitch: +(pc.angles.x * r2d).toFixed(1) };
    };
  });
  // helper that uses the page's THREE (via an existing object's constructor) to make an Euler
  await page.evaluate(() => {
    const pc = window.__pc(); const QC = pc.camera.quaternion.constructor; const EC = pc.camera.rotation.constructor;
    window.__eulFromQuat = (q) => new EC().setFromQuaternion(q, 'XYZ');
  });
  await page.evaluate(() => window.__step(160));   // settle, spawn look is ~level
  await page.evaluate(() => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); });
  await page.evaluate(() => window.__step(60));
  log('HIP (not aiming, standing, level):', JSON.stringify(await page.evaluate(() => window.__seat())));
  await page.evaluate(() => { const pc = window.__pc(); pc.aiming = true; pc._aimHeld = true; });
  await page.evaluate(() => window.__step(140));
  log('ADS (aiming, standing, level):  ', JSON.stringify(await page.evaluate(() => window.__seat())));
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
