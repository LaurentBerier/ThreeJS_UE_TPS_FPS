// FPS aim-alignment + reload verification harness. Boots the real game headless, switches to FPS, and
// captures ADS at level / up / down (gun-vs-crosshair alignment) plus a reload mid-frame (anim visible,
// camera fixed). Writes tools/_aim_*.png and tools/_reload_*.png.
//   node tools/fps_aimreload.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.fbx': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.obj': 'text/plain', '.wav': 'audio/wav', '.tga': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' });
  res.end(readFileSync(fpath));
});
const PORT = 8097;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=900,700'],
});
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
    window.__player = () => window._APP.entityManager.Get('Player');
    window.__pc = () => window.__player().GetComponent('PlayerControls');
    window.__wm = () => window.__player().GetComponent('WeaponManager');
    window.__toFPS = () => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); };
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__pitch = (rad) => { const pc = window.__pc(); pc.angles.x = rad; pc.UpdateRotation(); };
    window.__crouch = (on) => { const pc = window.__pc(); pc._crouchToggle = on; };
    window.__reload = () => { const wm = window.__wm(); if (wm && wm.Reload) wm.Reload(); };
  });
  await page.evaluate(() => window.__step(150));   // settle, FootIK calibrate
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));

  // --- ADS alignment sweep: level, up, down. The gun should stay under the centre crosshair at all three. ---
  for (const [name, rad] of [['level', 0], ['up', 0.7], ['down', -0.7]]) {
    await page.evaluate((r) => { window.__pitch(r); window.__aim(true); }, rad);
    await page.evaluate(() => window.__step(45));   // ease the ADS + lock in
    await page.screenshot({ path: join(ROOT, 'tools', `_aim_${name}.png`) });
    log(`wrote tools/_aim_${name}.png (ADS pitch=${rad})`);
  }

  // --- CROUCH + ADS alignment sweep: level, up, down. The gun should stay under the crosshair crouched too. ---
  await page.evaluate(() => { window.__crouch(true); });
  await page.evaluate(() => window.__step(60));
  for (const [name, rad] of [['level', 0], ['up', 0.7], ['down', -0.7]]) {
    await page.evaluate((r) => { window.__pitch(r); window.__aim(true); }, rad);
    await page.evaluate(() => window.__step(45));
    await page.screenshot({ path: join(ROOT, 'tools', `_crouchaim_${name}.png`) });
    log(`wrote tools/_crouchaim_${name}.png (CROUCH ADS pitch=${rad})`);
  }
  await page.evaluate(() => { window.__crouch(false); window.__pitch(0); window.__aim(false); });
  await page.evaluate(() => window.__step(60));

  // --- Reload: fire a couple shots to spend ammo, then reload and capture mid-anim. Camera must stay put. ---
  await page.evaluate(() => { window.__pitch(0); window.__aim(false); });
  await page.evaluate(() => window.__step(20));
  // Spend a round or two so CanReload() passes, then reload.
  await page.evaluate(() => {
    const wm = window.__wm();
    const w = wm ? wm.active : null;
    if (w && typeof w.magAmmo === 'number') { w.magAmmo = Math.max(0, w.magAmmo - 5); }
  });
  const eyeBefore = await page.evaluate(() => { const c = window.__pc().camera.position; return [c.x, c.y, c.z]; });
  await page.evaluate(() => window.__reload());
  for (const f of [12, 24, 40]) {
    await page.evaluate((n) => window.__step(n), f === 12 ? 12 : 12);
    await page.screenshot({ path: join(ROOT, 'tools', `_reload_${f}.png`) });
    const eye = await page.evaluate(() => { const c = window.__pc().camera.position; return [c.x, c.y, c.z]; });
    const d = Math.hypot(eye[0] - eyeBefore[0], eye[1] - eyeBefore[1], eye[2] - eyeBefore[2]);
    log(`wrote tools/_reload_${f}.png  eyeΔ from pre-reload = ${d.toFixed(4)} m`);
  }
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
