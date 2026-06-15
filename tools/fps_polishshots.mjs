// FPS polish screenshots — visual confirmation of the crouch-aim framing (#3), stand-aim, and a reload
// mid-frame. Writes tools/_polish_*.png. node tools/fps_polishshots.mjs
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
const PORT = 8097;
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
    window.__toFPS = () => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); };
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__pitch = (rad) => { const pc = window.__pc(); pc.angles.x = rad; pc.UpdateRotation(); };
    window.__crouch = (on) => { const pc = window.__pc(); pc._crouchToggle = on; };
    window.__reload = () => { window.__body().parent.Broadcast({ topic: 'weapon.reload' }); };
    window.__body = () => window._APP.entityManager.Get('Player').GetComponent('PlayerBody');
  });
  const shot = async (name) => { await page.evaluate(() => window._APP.renderer.render(window._APP.scene, window._APP.camera)); await page.screenshot({ path: join(ROOT, 'tools', name) }); log('wrote tools/' + name); };
  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));

  // Stand ADS (reference framing).
  await page.evaluate(() => { window.__crouch(false); window.__aim(true); window.__pitch(0); });
  await page.evaluate(() => window.__step(90));
  await shot('_polish_stand_aim.png');

  // Crouch ADS (#3 — gun should sit at ~the same framing as standing, near the crosshair).
  await page.evaluate(() => window.__crouch(true));
  await page.evaluate(() => window.__step(90));
  await shot('_polish_crouch_aim.png');

  // Reload while aiming, mid-frame (#5 — hands should be ON the gun working the mag).
  await page.evaluate(() => { window.__crouch(false); window.__aim(true); window.__pitch(0); });
  await page.evaluate(() => window.__step(60));
  await page.evaluate(() => window.__reload());
  await page.evaluate(() => window.__step(40));   // ~0.6s into the reload
  await shot('_polish_reload_mid.png');
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
