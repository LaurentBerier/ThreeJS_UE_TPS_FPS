// Render an FPS screenshot so the gun/hands framing can be judged + iterated. Boots the real game in
// headless Edge (software GL), switches to FPS, settles, and writes tools/_fps.png (and _fps_aim.png).
//   node tools/fps_shot.mjs
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
const PORT = 8096;
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
    window.__pc = () => window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    window.__toFPS = () => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); };
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    // Look slightly down so the chest-held gun frames in view (the player would naturally look at a threat).
    window.__pitch = (rad) => { const pc = window.__pc(); pc.angles.x = rad; pc.UpdateRotation(); };
  });
  await page.evaluate(() => window.__step(150));   // settle, FootIK calibrate
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));

  await page.evaluate(() => window.__step(1));
  await page.screenshot({ path: join(ROOT, 'tools', '_fps.png') });
  log('wrote tools/_fps.png (FPS hip)');

  // A touch of look-down (helps frame a low-held gun) + a separate shot.
  await page.evaluate(() => window.__pitch(-0.25));
  await page.evaluate(() => window.__step(20));
  await page.screenshot({ path: join(ROOT, 'tools', '_fps_down.png') });
  log('wrote tools/_fps_down.png (FPS looking down a bit)');

  await page.evaluate(() => { window.__pitch(0); window.__aim(true); });
  await page.evaluate(() => window.__step(40));
  await page.screenshot({ path: join(ROOT, 'tools', '_fps_aim.png') });
  log('wrote tools/_fps_aim.png (FPS ADS)');
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
