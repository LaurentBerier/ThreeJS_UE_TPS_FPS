// FPS aim-alignment probe. Projects the gun muzzle to screen NDC at several look pitches while ADS and
// reports how far the muzzle sits from screen-centre (the crosshair). 0 = perfectly under the crosshair.
//   node tools/fps_aimprobe.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.fbx': 'application/octet-stream', '.obj': 'text/plain',
  '.wav': 'audio/wav', '.tga': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' }); res.end(readFileSync(fpath));
});
const PORT = 8098;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=900,700'] });
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
    window.__toFPS = () => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); };
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__pitch = (rad) => { const pc = window.__pc(); pc.angles.x = rad; pc.UpdateRotation(); };
    window.__crouch = (on) => { const pc = window.__pc(); pc._crouchToggle = on; };
    // Project the gun muzzle (aim-IK debug, world) to screen NDC; (0,0) = crosshair centre.
    window.__probe = () => {
      const body = window.__body(); const pc = window.__pc();
      const ik = body.weaponAimIK; const cam = pc.camera;
      const d = ik && ik._debug ? ik._debug : null;
      if (!d || !d.muzzle) return null;
      const m = d.muzzle.clone().project(cam);            // muzzle NDC
      // Rear reference: weaponPivot world origin (~the receiver/sight base) projected to NDC.
      const rearW = new (m.constructor)();
      body.weaponPivot.getWorldPosition(rearW);
      const r = rearW.project(cam);
      // Barrel-forward vs camera-forward angle (deg): 0 = gun points exactly at the crosshair.
      const camFwd = new (m.constructor)(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      const ang = d.barrelFwd ? Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(camFwd)))) * 180 / Math.PI : -1;
      return { muzY: +m.y.toFixed(3), rearX: +r.x.toFixed(3), rearY: +r.y.toFixed(3),
               barrelDeg: +ang.toFixed(2), eyeY: +cam.position.y.toFixed(3), lockW: +(body._fpsAimLockW ?? 0).toFixed(2) };
    };
  });
  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));
  await page.evaluate(() => window.__aim(true));
  for (const crouch of [false, true]) {
    await page.evaluate((c) => window.__crouch(c), crouch);
    await page.evaluate(() => window.__step(60));   // settle the crouch ease
    log(`--- ${crouch ? 'CROUCH' : 'STAND'} + ADS ---`);
    for (const rad of [0, 0.7, -0.7]) {
      await page.evaluate((r) => window.__pitch(r), rad);
      await page.evaluate(() => window.__step(60));
      const r = await page.evaluate(() => window.__probe());
      log(`  pitch=${String(rad).padStart(5)}  muzY=${String(r.muzY).padStart(7)}  rear NDC=(${String(r.rearX).padStart(7)},${String(r.rearY).padStart(7)})  barrelDeg=${String(r.barrelDeg).padStart(6)}  eyeY=${r.eyeY}  lockW=${r.lockW}`);
    }
  }
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
