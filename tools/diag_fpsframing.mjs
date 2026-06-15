// FPS ADS framing + terrain-independence check (after the eye foot-plant comp). Measures the gun's
// on-screen vertical (rearY NDC + gunCamY metres) and barrel-on-target while: standing ADS, strafing ADS
// at a near spot, and strafing ADS at a far/rougher spot. A robust ADS keeps these CONSISTENT (gun at the
// same place under the crosshair regardless of terrain/motion) and STEADY (small range). Saves screenshots.
//   node tools/diag_fpsframing.mjs
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
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
const PORT = 8102;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/fpsframing-chrome', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
const f = (n) => String(+n.toFixed(3)).padStart(8);

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
    window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
    window.__probe = () => {
      const body = window.__body(); const pc = window.__pc(); const cam = pc.camera;
      const rearW = body.weaponPivot.getWorldPosition(new cam.position.constructor());
      const r = rearW.clone().project(cam);
      const gunCam = rearW.clone().applyMatrix4(cam.matrixWorldInverse);
      const ik = body.weaponAimIK; const d = ik && ik._debug ? ik._debug : null;
      let barrelDeg = -1;
      if (d && d.muzzle && d.barrelFwd) {
        const camFwd = new d.muzzle.constructor(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
        barrelDeg = +(Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(camFwd)))) * 180 / Math.PI).toFixed(2);
      }
      return { rearY: +r.y.toFixed(3), gunCamY: +gunCam.y.toFixed(3), barrelDeg, hipDrop: +(body.footIK?._hipDrop ?? 0).toFixed(3) };
    };
    window.__sampleY = (n) => { const ys = []; for (let i = 0; i < n; i++) { window.__step(1); ys.push(window.__probe().rearY); } return { min: Math.min(...ys), max: Math.max(...ys), range: Math.max(...ys) - Math.min(...ys), last: window.__probe() }; };
  });

  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));

  // STANDING ADS
  await page.evaluate(() => window.__aim(true));
  await page.evaluate(() => window.__step(90));
  let s = await page.evaluate(() => window.__sampleY(60));
  log(`STAND   ADS: rearY=${f(s.last.rearY)} range=${f(s.range)} gunCamY=${f(s.last.gunCamY)} barrelDeg=${f(s.last.barrelDeg)} hipDrop=${f(s.last.hipDrop)}`);
  writeFileSync(join('/tmp', 'fps_stand_ads.png'), await page.screenshot({ encoding: 'binary' }));

  // STRAFE near
  await page.evaluate(() => window.__key('KeyD', true));
  await page.evaluate(() => window.__step(70));
  s = await page.evaluate(() => window.__sampleY(60));
  log(`STRAFE@near: rearY=${f(s.last.rearY)} range=${f(s.range)} gunCamY=${f(s.last.gunCamY)} barrelDeg=${f(s.last.barrelDeg)} hipDrop=${f(s.last.hipDrop)}`);
  writeFileSync(join('/tmp', 'fps_strafe_near.png'), await page.screenshot({ encoding: 'binary' }));

  // STRAFE far (rougher terrain)
  await page.evaluate(() => window.__step(220));
  s = await page.evaluate(() => window.__sampleY(60));
  log(`STRAFE@far : rearY=${f(s.last.rearY)} range=${f(s.range)} gunCamY=${f(s.last.gunCamY)} barrelDeg=${f(s.last.barrelDeg)} hipDrop=${f(s.last.hipDrop)}`);
  writeFileSync(join('/tmp', 'fps_strafe_far.png'), await page.screenshot({ encoding: 'binary' }));
  await page.evaluate(() => window.__key('KeyD', false));
  log('screenshots: /tmp/fps_stand_ads.png /tmp/fps_strafe_near.png /tmp/fps_strafe_far.png');
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
