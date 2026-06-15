// Quick regression: boot the game, exercise BOTH camera modes (aim / reload / crouch / move / toggle),
// and assert zero runtime errors (pageerror + console.error). Guards that the FPS-only fixes didn't
// regress TPS or throw. node tools/fps_regress.mjs
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
const PORT = 8095;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE.ERROR: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    window.__pc = () => window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    window.__body = () => window._APP.entityManager.Get('Player').GetComponent('PlayerBody');
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__crouch = (on) => { window.__pc()._crouchToggle = on; };
    window.__reload = () => { window.__body().parent.Broadcast({ topic: 'weapon.reload' }); };
    window.__mode = () => window.__pc().cameraMode;
    window.__toggle = () => window.__pc().ToggleCamera();
    window.__move = (on) => document.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: 'KeyW', key: 'w', bubbles: true }));
  });
  const seq = async (label) => { log(`  ${label}: mode=${await page.evaluate(() => window.__mode())}`); };
  await page.evaluate(() => window.__step(150));
  // TPS exercise (starts in TPS).
  await page.evaluate(() => { window.__aim(true); window.__crouch(true); }); await page.evaluate(() => window.__step(40));
  await page.evaluate(() => window.__reload()); await page.evaluate(() => window.__step(60));
  await page.evaluate(() => { window.__move(true); }); await page.evaluate(() => window.__step(40));
  await page.evaluate(() => { window.__move(false); window.__aim(false); window.__crouch(false); }); await page.evaluate(() => window.__step(40));
  await seq('TPS aim+crouch+reload+move');
  // Toggle FPS, exercise.
  await page.evaluate(() => { if (window.__mode() !== 'FPS') window.__toggle(); }); await page.evaluate(() => window.__step(40));
  await page.evaluate(() => { window.__aim(true); }); await page.evaluate(() => window.__step(40));
  await page.evaluate(() => { window.__crouch(true); }); await page.evaluate(() => window.__step(50));
  await page.evaluate(() => window.__reload()); await page.evaluate(() => window.__step(60));
  await page.evaluate(() => { window.__move(true); }); await page.evaluate(() => window.__step(40));
  await page.evaluate(() => { window.__move(false); window.__aim(false); window.__crouch(false); }); await page.evaluate(() => window.__step(40));
  await seq('FPS aim+crouch+reload+move');
  // Toggle back to TPS.
  await page.evaluate(() => { if (window.__mode() !== 'TPS') window.__toggle(); }); await page.evaluate(() => window.__step(40));
  await seq('back to TPS');
  log(`\nRESULT: ${errors.length === 0 ? 'PASS (0 errors)' : 'FAIL (' + errors.length + ' errors)'}`);
  errors.slice(0, 30).forEach(e => log('  ' + e));
  if (errors.length) process.exitCode = 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
