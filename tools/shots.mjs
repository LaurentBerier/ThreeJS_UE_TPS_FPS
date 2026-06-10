// Visual capture: render the REAL game camera in key states (crouch / aim, TPS+FPS) so the poses can
// be eyeballed (metrics can't tell a giant-stride from a clean plant, or whether the aim pose reads).
// Software WebGL renders on demand, so we step a few frames then render+screenshot each state.
//   CHROME_BIN="...msedge.exe" node tools/shots.mjs   ->  writes tools/shot_*.png
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.fbx': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.obj': 'text/plain', '.wav': 'audio/wav', '.tga': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' }); res.end(readFileSync(fpath));
});
const PORT = 8093;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1000,700'],
});
const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  page.on('pageerror', (e) => log('PAGEERR', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window._APP.OnAnimationFrameHandler = () => {};       // stop rAF clobbering our manual renders
    window.__realRender = window._APP.renderer.render.bind(window._APP.renderer);
    window.__step = (n, dt = 1/60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    window.__render = () => window.__realRender(window._APP.scene, window._APP.camera);
    const P = () => window._APP.entityManager.Get('Player');
    window.__pc = () => P().GetComponent('PlayerControls');
    window.__press = (c) => document.dispatchEvent(new KeyboardEvent('keydown', { code: c }));
    window.__release = (c) => document.dispatchEvent(new KeyboardEvent('keyup', { code: c }));
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__fps = (on) => { const pc = window.__pc(); if ((pc.cameraMode === 'FPS') !== on) pc.ToggleCamera(); };
    window.__crouch = (on) => { window.__pc()._crouchToggle = on; };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);
  await step(220); // settle + FootIK calibrate

  const shot = async (name, setup, settle = 60) => {
    await page.evaluate(setup);
    await step(settle);
    await page.evaluate(() => window.__render());
    const out = join(__dir, `shot_${name}.png`);
    const buf = await page.screenshot({ type: 'png' });
    writeFileSync(out, buf);
    log('wrote', out);
  };

  // TPS states
  await shot('tps_idle', () => { window.__fps(false); window.__crouch(false); window.__aim(false); window.__release('KeyW'); });
  await shot('tps_aim', () => { window.__aim(true); }, 50);
  await shot('tps_crouch_idle', () => { window.__aim(false); window.__crouch(true); }, 60);
  // crouch-walk: press W and grab a mid-stride frame
  await page.evaluate(() => window.__press('KeyW')); await step(70);
  await page.evaluate(() => window.__render());
  writeFileSync(join(__dir, 'shot_tps_crouch_walk.png'), await page.screenshot({ type: 'png' }));
  log('wrote shot_tps_crouch_walk.png');
  await page.evaluate(() => { window.__release('KeyW'); window.__crouch(false); }); await step(40);

  // FPS states
  await shot('fps_idle', () => { window.__fps(true); window.__aim(false); }, 40);
  await shot('fps_aim', () => { window.__aim(true); }, 50);

  log('done');
} catch (e) { log('HARNESS ERROR', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
