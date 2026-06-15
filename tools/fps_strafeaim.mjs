// FPS strafe-ADS HORIZONTAL offset probe. With a STEADY camera, strafes back and forth (D/A) while ADS
// and measures the gun's horizontal screen position (rearX NDC + gunCamX metres) and barrel-on-target at
// the END of each strafe leg, over several cycles. A locked ADS keeps the gun under the crosshair the same
// way for LEFT and RIGHT strafe (left-vs-right delta ~0) and does NOT drift over repeated cycles.
//   node tools/fps_strafeaim.mjs
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
const PORT = 8099;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/strafeaim-chrome', '--window-size=900,700'] });
const log = (...a) => console.log(...a);
const f = (n, w = 8) => String(+n.toFixed(3)).padStart(w);

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
      const gunCam = rearW.clone().applyMatrix4(cam.matrixWorldInverse);  // camera-local (x right, y up)
      const ik = body.weaponAimIK; const d = ik && ik._debug ? ik._debug : null;
      let barrelDeg = -1, muzX = null;
      if (d && d.muzzle) {
        muzX = +d.muzzle.clone().project(cam).x.toFixed(3);
        if (d.barrelFwd) { const cf = new d.muzzle.constructor(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
          barrelDeg = +(Math.acos(Math.max(-1, Math.min(1, d.barrelFwd.dot(cf)))) * 180 / Math.PI).toFixed(2); }
      }
      // body-vs-look yaw lag (deg): how far the body facing trails the camera look yaw.
      const yawLag = +((body._bodyYaw - (pc.angles.y + (body.yawOffset || 0))) * 180 / Math.PI).toFixed(2);
      return { rearX: +r.x.toFixed(3), gunCamX: +gunCam.x.toFixed(4), muzX, barrelDeg, yawLag,
               lower: body.lowerState, moveLockW: +(body._fpsMoveLockW ?? 0).toFixed(2),
               refValid: !!body._fpsAimGunCamValid, stab: +(body._aimIdleStab ?? 0).toFixed(2) };
    };
  });

  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));
  // Aim while STANDING first so the stance-lock reference gets captured (as in normal play).
  await page.evaluate(() => window.__aim(true));
  await page.evaluate(() => window.__step(90));
  const stand = await page.evaluate(() => window.__probe());
  log(`STAND ADS: rearX=${f(stand.rearX)} gunCamX=${f(stand.gunCamX)} muzX=${f(stand.muzX)} barrelDeg=${f(stand.barrelDeg)} yawLag=${f(stand.yawLag)} refValid=${stand.refValid}`);

  log('\nBack-and-forth strafe (steady camera), gun horizontal at the END of each leg:');
  log('  leg            rearX   gunCamX    muzX  barrelDeg  yawLag  lower  moveLockW');
  for (let cyc = 0; cyc < 4; cyc++) {
    // strafe RIGHT
    await page.evaluate(() => { window.__key('KeyA', false); window.__key('KeyD', true); });
    await page.evaluate(() => window.__step(70));
    let r = await page.evaluate(() => window.__probe());
    log(`  cyc${cyc} RIGHT  ${f(r.rearX)} ${f(r.gunCamX)} ${f(r.muzX)} ${f(r.barrelDeg)} ${f(r.yawLag)}   ${r.lower}   ${f(r.moveLockW)}`);
    // strafe LEFT
    await page.evaluate(() => { window.__key('KeyD', false); window.__key('KeyA', true); });
    await page.evaluate(() => window.__step(70));
    r = await page.evaluate(() => window.__probe());
    log(`  cyc${cyc} LEFT   ${f(r.rearX)} ${f(r.gunCamX)} ${f(r.muzX)} ${f(r.barrelDeg)} ${f(r.yawLag)}   ${r.lower}   ${f(r.moveLockW)}`);
  }
  await page.evaluate(() => window.__key('KeyA', false));
  // back to standing — does it recenter?
  await page.evaluate(() => window.__step(90));
  const back = await page.evaluate(() => window.__probe());
  log(`\nSTAND again: rearX=${f(back.rearX)} gunCamX=${f(back.gunCamX)} muzX=${f(back.muzX)} barrelDeg=${f(back.barrelDeg)}  (vs initial stand rearX=${f(stand.rearX)})`);
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
