// FPS camera-authoritative viewmodel — state sweep. Verifies the gun barrel stays on the crosshair through
// the locomotion states that used to offset it: strafe (incl. rapid reversal), walk fwd/back, crouch enter/
// exit, and hip-fire (not aiming). Measures the barrel-vs-camera-forward angle (deg) per state — it must
// stay small (a few deg max, settling ~0) with no persistent offset. Also samples the gun cam-local pose.
//   node tools/diag_fpsaim.mjs
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
const PORT = 8101;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/diagfpsaim-chrome', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
const f = (n, w = 7) => String(+(n ?? 0).toFixed(3)).padStart(w);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE.ERROR', m.text()); });
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
    // convDeg = TRUE convergence: angle between where the barrel ACTUALLY points (barrelFwd) and the line
    // from the MUZZLE to the aim target (correctedDir). ~0 = the muzzle ray hits the reticle target. (NOT
    // barrel-vs-camera-forward: for a NEAR target that differs by the gun<->eye PARALLAX, which is correct.)
    window.__probe = () => {
      const body = window.__body(); const pc = window.__pc(); const cam = pc.camera;
      const gunW = body.weaponPivot.getWorldPosition(new cam.position.constructor());
      const gunCam = gunW.clone().applyMatrix4(cam.matrixWorldInverse);
      const d = body.weaponAimIK && body.weaponAimIK._debug ? body.weaponAimIK._debug : null;
      let convDeg = -1, paraDeg = -1;
      if (d && d.barrelFwd && d.correctedDir && d.correctedDir.lengthSq() > 1e-8) {
        convDeg = +(Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(d.correctedDir)))) * 180 / Math.PI).toFixed(3);
        const cf = new gunW.constructor(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
        paraDeg = +(Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(cf)))) * 180 / Math.PI).toFixed(3);
      }
      return { x: gunCam.x, y: gunCam.y, convDeg, paraDeg, spd: +pc.HorizontalSpeed.toFixed(2), lower: body.lowerState, crouch: pc.crouching };
    };
    window.__samp = (n) => {
      const xs = [], ys = [], cs = [], ps = [];
      for (let i = 0; i < n; i++) { window.__step(1); const p = window.__probe(); xs.push(p.x); ys.push(p.y); if (p.convDeg >= 0) { cs.push(p.convDeg); ps.push(p.paraDeg); } }
      const st = (a) => ({ min: Math.min(...a), max: Math.max(...a), range: Math.max(...a) - Math.min(...a) });
      return { x: st(xs), y: st(ys), conv: st(cs), para: st(ps), last: window.__probe() };
    };
    window.__clearKeys = () => ['KeyW','KeyA','KeyS','KeyD'].forEach(k => window.__key(k, false));
    // Toggle crouch with a Step between down/up so the latch edge actually fires.
    window.__crouch = (on) => { window.__key('KeyC', true); window.__step(2); window.__key('KeyC', false); window.__step(2); };
  });

  const row = (label, s) => log(`${label.padEnd(18)} CONVERGE max=${f(s.conv.max)} min=${f(s.conv.min)}  [parallax max=${f(s.para.max)}]  gunCam range x=${f(s.x.range)} y=${f(s.y.range)}  (spd=${f(s.last.spd)} crouch=${s.last.crouch?1:0} ${s.last.lower})`);

  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); });
  await page.evaluate(() => window.__step(40));

  // --- HIP (not aiming): the gun should still point at the crosshair (always-aligned). ---
  let s = await page.evaluate(() => window.__samp(60));
  row('HIP idle', s);
  await page.evaluate(() => { window.__key('KeyA', true); });
  s = await page.evaluate(() => window.__samp(60)); row('HIP strafe-L', s);
  await page.evaluate(() => { window.__key('KeyA', false); window.__key('KeyD', true); });
  s = await page.evaluate(() => window.__samp(60)); row('HIP strafe-R(rev)', s);
  await page.evaluate(() => window.__clearKeys());
  await page.evaluate(() => window.__step(40));

  // --- ADS standing ---
  await page.evaluate(() => { const pc = window.__pc(); pc.aiming = true; pc._aimHeld = true; });
  await page.evaluate(() => window.__step(120));  // settle + calibrate
  s = await page.evaluate(() => window.__samp(60)); row('ADS stand', s);

  // --- ADS strafe + rapid reversal (the original worst case) ---
  await page.evaluate(() => window.__key('KeyA', true));
  s = await page.evaluate(() => window.__samp(70)); row('ADS strafe-L', s);
  await page.evaluate(() => { window.__key('KeyA', false); window.__key('KeyD', true); });
  s = await page.evaluate(() => window.__samp(70)); row('ADS strafe-R(rev)', s);
  // hammer the reversal a few times
  for (let r = 0; r < 3; r++) {
    await page.evaluate(() => { window.__key('KeyD', false); window.__key('KeyA', true); });
    await page.evaluate(() => window.__step(18));
    await page.evaluate(() => { window.__key('KeyA', false); window.__key('KeyD', true); });
    await page.evaluate(() => window.__step(18));
  }
  s = await page.evaluate(() => window.__samp(40)); row('ADS reversal x3', s);
  await page.evaluate(() => window.__clearKeys());
  await page.evaluate(() => window.__step(40));

  // --- ADS walk forward / back ---
  await page.evaluate(() => window.__key('KeyW', true));
  s = await page.evaluate(() => window.__samp(60)); row('ADS walk-fwd', s);
  await page.evaluate(() => { window.__key('KeyW', false); window.__key('KeyS', true); });
  s = await page.evaluate(() => window.__samp(60)); row('ADS walk-back', s);
  await page.evaluate(() => window.__clearKeys());
  await page.evaluate(() => window.__step(40));

  // --- ADS crouch enter / hold / exit (real toggle: Step between down/up) ---
  await page.evaluate(() => window.__crouch(true));
  s = await page.evaluate(() => window.__samp(70)); row('ADS crouch-enter', s);
  s = await page.evaluate(() => window.__samp(40)); row('ADS crouch-hold', s);
  await page.evaluate(() => window.__crouch(false));
  s = await page.evaluate(() => window.__samp(70)); row('ADS crouch-exit', s);
  await page.evaluate(() => window.__step(40));

  // --- crouch-walk ADS ---
  await page.evaluate(() => { window.__crouch(true); window.__key('KeyA', true); });
  s = await page.evaluate(() => window.__samp(60)); row('ADS crouch-strafe', s);
  await page.evaluate(() => { window.__clearKeys(); window.__crouch(false); });
  await page.evaluate(() => window.__step(60));

  const end = await page.evaluate(() => window.__probe());
  log(`\nEND ADS stand: converge=${f(end.convDeg)}  parallax=${f(end.paraDeg)}  gunCam=(${f(end.x)},${f(end.y)})`);
  log('PASS if every CONVERGE max is ~0 (muzzle ray hits the reticle) with gunCam range tiny.');
  log('(parallax = barrel vs camera-forward; nonzero for near targets is CORRECT, not error.)');
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
