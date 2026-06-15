// Trace the FPS strafe-ADS gun offset THROUGH a direction reversal (jogR -> jogL), the case that goes bad.
// Logs the gun's camera-local X (horizontal screen offset) + barrel-on-target + state every 10 frames so we
// can see whether a reversal settles back to centred or gets stuck/drifts, and what correlates.
//   node tools/diag_bones.mjs
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
    '--user-data-dir=/tmp/diagbones-chrome', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
const f = (n, w = 8) => String(+(n ?? 0).toFixed(3)).padStart(w);

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
    window.__key = (code, down) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
    window.__probe = () => {
      const body = window.__body(); const pc = window.__pc(); const cam = pc.camera;
      const gunW = body.weaponPivot.getWorldPosition(new cam.position.constructor());
      const gunCam = gunW.clone().applyMatrix4(cam.matrixWorldInverse);
      const ik = body.weaponAimIK; const d = ik && ik._debug ? ik._debug : null;
      let barrelDeg = -1;
      if (d && d.barrelFwd) { const cf = new gunW.constructor(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
        barrelDeg = +(Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(cf)))) * 180 / Math.PI).toFixed(2); }
      return { gunCamX: gunCam.x, barrelDeg, lower: body.lowerState, upper: body.upperState,
               spd: pc.HorizontalSpeed, vx: pc.speed.x, px: pc.parent.Position.x, pz: pc.parent.Position.z,
               muzzleLift: ik._muzzleLift ?? 0, moveLockW: body._fpsMoveLockW ?? 0 };
    };
    window.__trace = (n, label) => { const rows = []; for (let i = 0; i < n; i++) { window.__step(1); if (i % 10 === 0) rows.push(window.__probe()); } return rows; };
  });

  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); });
  await page.evaluate(() => window.__step(40));
  await page.evaluate(() => { const pc = window.__pc(); pc.aiming = true; pc._aimHeld = true; });
  await page.evaluate(() => window.__step(90));
  // strafe RIGHT, settle
  await page.evaluate(() => window.__key('KeyD', true));
  await page.evaluate(() => window.__step(110));
  log('At end of RIGHT strafe: ' + JSON.stringify(await page.evaluate(() => window.__probe())));
  // REVERSE to LEFT and trace the trajectory
  log('\nReverse to LEFT — trace every 10 frames (gunCamX = horizontal screen offset):');
  log('  fr   gunCamX  barrelDeg   spd     vx      px      pz    mLift  moveLk  lower');
  const rows = await page.evaluate(() => { window.__key('KeyD', false); window.__key('KeyA', true); return window.__trace(240, 'LEFT'); });
  rows.forEach((r, i) => log(`  ${String(i * 10).padStart(3)} ${f(r.gunCamX)} ${f(r.barrelDeg)} ${f(r.spd)} ${f(r.vx)} ${f(r.px)} ${f(r.pz)} ${f(r.muzzleLift)} ${f(r.moveLockW)}  ${r.lower}`));
  await page.evaluate(() => window.__key('KeyA', false));
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
