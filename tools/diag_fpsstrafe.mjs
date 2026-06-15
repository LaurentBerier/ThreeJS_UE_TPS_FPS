// FPS ADS robustness vs body animation: does the gun stay camera-pinned through a JUMP, a HURT-FLINCH, and a
// ROLL recovery while aiming? Measures the gun's camera-LOCAL pose (x,y = screen offset, constant = pinned)
// and barrel-on-target, sampling THROUGH each event. With the camera-lock the gun cam-local pose + barrel
// should stay ~constant (the body animation is overwritten); without it they swing.
//   node tools/diag_fpsstrafe.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import os from 'os';
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
const PORT = 8100;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/diagfps-chrome', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
const f = (n, w = 8) => String(+(n ?? 0).toFixed(4)).padStart(w);

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
    window.__player = () => window._APP.entityManager.Get('Player');
    window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
    window.__probe = () => {
      const body = window.__body(); const pc = window.__pc(); const cam = pc.camera;
      const gunW = body.weaponPivot.getWorldPosition(new cam.position.constructor());
      const gunCam = gunW.clone().applyMatrix4(cam.matrixWorldInverse);
      const ik = body.weaponAimIK; const d = ik && ik._debug ? ik._debug : null;
      let barrelDeg = -1;
      if (d && d.barrelFwd) { const cf = new gunW.constructor(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
        barrelDeg = +(Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(cf)))) * 180 / Math.PI).toFixed(2); }
      return { x: gunCam.x, y: gunCam.y, z: gunCam.z, barrelDeg, air: body.airState, rolling: body.rolling };
    };
    // sample N frames, return min/max/range of gun cam-local x,y + barrel
    window.__samp = (n) => {
      const xs = [], ys = [], degs = [];
      for (let i = 0; i < n; i++) { window.__step(1); const p = window.__probe(); xs.push(p.x); ys.push(p.y); if (p.barrelDeg >= 0) degs.push(p.barrelDeg); }
      const st = (a) => ({ min: Math.min(...a), max: Math.max(...a), range: Math.max(...a) - Math.min(...a) });
      return { x: st(xs), y: st(ys), deg: st(degs), last: window.__probe() };
    };
  });

  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); });
  await page.evaluate(() => window.__step(40));
  await page.evaluate(() => { const pc = window.__pc(); pc.aiming = true; pc._aimHeld = true; });
  await page.evaluate(() => window.__step(120));   // settle + capture the calibrated reference
  const base = await page.evaluate(() => window.__probe());
  log(`BASE stand-ADS: gunCam=(${f(base.x)},${f(base.y)},${f(base.z)})  barrelDeg=${f(base.barrelDeg)}`);
  log('(success = the gun cam-local x,y + barrel stay ~constant through each event; range ~0 = pinned)\n');

  // JUMP while aiming
  await page.evaluate(() => window.__key('Space', true));
  await page.evaluate(() => window.__step(2));
  await page.evaluate(() => window.__key('Space', false));
  let s = await page.evaluate(() => window.__samp(70));   // through the jump arc
  log(`JUMP+ADS : x range=${f(s.x.range)} [${f(s.x.min)},${f(s.x.max)}]  y range=${f(s.y.range)}  barrel max=${f(s.deg.max)}  (air=${s.last.air})`);
  await page.evaluate(() => window.__step(80));   // land + settle

  // HURT FLINCH while aiming
  await page.evaluate(() => window.__player().Broadcast({ topic: 'hit', amount: 25 }));
  s = await page.evaluate(() => window.__samp(50));
  log(`FLINCH+ADS: x range=${f(s.x.range)} [${f(s.x.min)},${f(s.x.max)}]  y range=${f(s.y.range)}  barrel max=${f(s.deg.max)}`);
  await page.evaluate(() => window.__step(40));

  // ROLL while aiming (recovery)
  await page.evaluate(() => { const pc = window.__pc(); pc.rollDir = new pc.camera.position.constructor(0, 0, 1); window.__player().Broadcast({ topic: 'player.roll' }); });
  s = await page.evaluate(() => window.__samp(90));   // through the roll + recovery
  log(`ROLL+ADS : x range=${f(s.x.range)} [${f(s.x.min)},${f(s.x.max)}]  y range=${f(s.y.range)}  barrel max=${f(s.deg.max)}  (rolling tail=${s.last.rolling})`);
  await page.evaluate(() => window.__step(60));
  const end = await page.evaluate(() => window.__probe());
  log(`\nEND stand-ADS: gunCam=(${f(end.x)},${f(end.y)},${f(end.z)})  barrelDeg=${f(end.barrelDeg)}  (vs BASE x=${f(base.x)} y=${f(base.y)})`);
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
