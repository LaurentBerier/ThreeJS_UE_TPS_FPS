// Diagnostic: TPS crouch CAMERA jitter + crouch ANIMATION glitches. Compares per-frame camera-Y
// motion standing vs crouched (idle + walking), and watches the pose for discontinuities:
// per-frame calf/thigh world-rotation jerk (knee snap), modelRoot Y steps, locomotion state
// flickers, FootIK weight oscillation, crouch-depth (_crouchMoveRaise) bob.
//   node tools/diag_crouchcam.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';
import os from 'os';

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
const PORT = 8094;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/crouchcam-chrome', '--window-size=900,600'],
});
const errors = [];
const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE.ERROR: ' + m.text()); });

  log('loading game…');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });

  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window._APP.OnAnimationFrameHandler = () => {};
    window._APP.renderer.render = () => {};
    const P = () => window._APP.entityManager.Get('Player');
    window.__pc = () => P().GetComponent('PlayerControls');
    window.__ph = () => P().GetComponent('PlayerPhysics');
    window.__body = () => P().GetComponent('PlayerBody');
    window.__press = (code) => document.dispatchEvent(new KeyboardEvent('keydown', { code }));
    window.__release = (code) => document.dispatchEvent(new KeyboardEvent('keyup', { code }));
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    const bones = () => { const b = {}; window.__body().model.traverse(o => { if (o.isBone) b[o.name] = o; }); return b;
    };
    // Rich per-frame sampler for camera + pose smoothness.
    window.__run = (frames) => {
      const B = bones();
      const Q = B['calf_l'].getWorldQuaternion(B['calf_l'].quaternion.constructor ? new B['calf_l'].quaternion.constructor() : null).constructor;
      const q = { cl: new Q(), cr: new Q(), tl: new Q(), tr: new Q() };
      const prev = { cl: new Q(), cr: new Q(), tl: new Q(), tr: new Q() };
      const grab = (dst) => {
        B['calf_l'].getWorldQuaternion(dst.cl); B['calf_r'].getWorldQuaternion(dst.cr);
        B['thigh_l'].getWorldQuaternion(dst.tl); B['thigh_r'].getWorldQuaternion(dst.tr);
      };
      grab(prev);
      const out = [];
      for (let i = 0; i < frames; i++) {
        window.__step(1);
        const pc = window.__pc(), bd = window.__body(), ph = window.__ph();
        grab(q);
        const jerk = Math.max(prev.cl.angleTo(q.cl), prev.cr.angleTo(q.cr), prev.tl.angleTo(q.tl), prev.tr.angleTo(q.tr)) * 180 / Math.PI;
        prev.cl.copy(q.cl); prev.cr.copy(q.cr); prev.tl.copy(q.tl); prev.tr.copy(q.tr);
        const o = ph.body.getWorldTransform().getOrigin();
        out.push({
          camY: +window._APP.camera.position.y.toFixed(5),
          camX: +window._APP.camera.position.x.toFixed(5),
          camZ: +window._APP.camera.position.z.toFixed(5),
          py: +o.y().toFixed(5),
          eyeY: +P().Position.y.toFixed(5),
          rootY: +bd.modelRoot.position.y.toFixed(5),
          jerk: +jerk.toFixed(2),
          loco: bd.lowerState || '-', air: bd.airState || '-',
          cj: ph.canJump ? 1 : 0, crP: ph.crouched ? 1 : 0,
          ce: +bd._crouchEased.toFixed(4), cmr: +bd._crouchMoveRaise.toFixed(4),
          fw: bd.footIK ? +bd.footIK._weight.toFixed(3) : -1,
          spd: +pc.HorizontalSpeed.toFixed(2),
        });
      }
      return out;
    };
  });

  const run = (n) => page.evaluate((n) => window.__run(n), n);
  const press = (c) => page.evaluate((c) => window.__press(c), c);
  const release = (c) => page.evaluate((c) => window.__release(c), c);
  const step = (n) => page.evaluate((n) => window.__step(n), n);

  // Stats over a trace: per-frame camera vertical delta (jitter), capsule delta, pose jerk,
  // loco-state flickers, FootIK weight swings, grounded flickers.
  const stats = (name, tr, skip = 10) => {
    const t = tr.slice(skip);
    let maxD = 0, rms = 0, n = 0, maxJerk = 0, jerkAt = -1, maxCapD = 0;
    let locoChanges = [], cjDrops = 0, fwMin = 2, fwMax = -1, cmrMin = 2, cmrMax = -1;
    for (let i = 1; i < t.length; i++) {
      const d = Math.abs(t[i].camY - t[i - 1].camY);
      const cd = Math.abs(t[i].py - t[i - 1].py);
      maxD = Math.max(maxD, d); rms += d * d; n++;
      maxCapD = Math.max(maxCapD, cd);
      if (t[i].jerk > maxJerk) { maxJerk = t[i].jerk; jerkAt = i + skip; }
      if (t[i].loco !== t[i - 1].loco) locoChanges.push(`f${i + skip}:${t[i - 1].loco}→${t[i].loco}`);
      if (t[i].cj === 0 && t[i - 1].cj === 1) cjDrops++;
      fwMin = Math.min(fwMin, t[i].fw); fwMax = Math.max(fwMax, t[i].fw);
      cmrMin = Math.min(cmrMin, t[i].cmr); cmrMax = Math.max(cmrMax, t[i].cmr);
    }
    rms = Math.sqrt(rms / Math.max(1, n));
    log(`\n=== ${name} ===`);
    log(`  camY jitter: max ${(maxD * 1000).toFixed(1)} mm/frame, rms ${(rms * 1000).toFixed(2)} mm/frame`);
    log(`  capsule py:  max ${(maxCapD * 1000).toFixed(1)} mm/frame`);
    log(`  pose jerk:   max ${maxJerk.toFixed(1)} °/frame (leg bones, world) at f${jerkAt}`);
    log(`  loco flicker: ${locoChanges.length ? locoChanges.join(' ') : 'none'}   groundedDrops: ${cjDrops}`);
    log(`  footIK w: [${fwMin.toFixed(2)}..${fwMax.toFixed(2)}]  crouchMoveRaise: [${cmrMin.toFixed(2)}..${cmrMax.toFixed(2)}]`);
    return { maxD, rms, maxJerk, locoChanges, cjDrops };
  };

  await step(240);   // settle + FootIK calibration

  // --- baseline: standing idle ---
  stats('standing IDLE', await run(150));

  // --- crouch ENTER from idle (the moment of the glitch?) ---
  await press('KeyC'); await step(1); await release('KeyC');
  const enterTr = await run(120);
  stats('crouch ENTER + crouch idle', enterTr, 0);
  // print the first 14 frames in detail — any one-frame step in camY/rootY/jerk is the glitch
  log('  enter detail:');
  enterTr.slice(0, 14).forEach((s, i) => log(
    `   f${String(i).padStart(2)} camY=${s.camY.toFixed(4)} eyeY=${s.eyeY.toFixed(4)} rootY=${s.rootY.toFixed(4)} ` +
    `ce=${s.ce.toFixed(3)} jerk=${String(s.jerk).padStart(5)}° fw=${s.fw} loco=${s.loco}`));

  // --- crouch EXIT to idle ---
  await press('KeyC'); await step(1); await release('KeyC');
  const exitTr = await run(120);
  stats('crouch EXIT + standing idle', exitTr, 0);
  log('  exit detail:');
  exitTr.slice(0, 14).forEach((s, i) => log(
    `   f${String(i).padStart(2)} camY=${s.camY.toFixed(4)} eyeY=${s.eyeY.toFixed(4)} rootY=${s.rootY.toFixed(4)} ` +
    `ce=${s.ce.toFixed(3)} jerk=${String(s.jerk).padStart(5)}° fw=${s.fw} loco=${s.loco}`));
  await step(60);

  // --- standing WALK baseline (W) ---
  await press('KeyW'); await step(30);
  const standWalk = stats('standing WALK (W)', await run(240));
  await release('KeyW'); await step(60);

  // --- crouch WALK (C + W) ---
  await press('KeyC'); await step(1); await release('KeyC'); await step(60);
  await press('KeyW'); await step(30);
  const crouchWalk = stats('crouch WALK (C+W)', await run(240));
  await release('KeyW'); await step(30);
  await press('KeyC'); await step(1); await release('KeyC'); await step(60);

  log('\n==== COMPARISON ====');
  log(`  camY rms jitter: standing-walk ${(standWalk.rms * 1000).toFixed(2)} mm/f  vs crouch-walk ${(crouchWalk.rms * 1000).toFixed(2)} mm/f` +
      `  (${(crouchWalk.rms / Math.max(1e-9, standWalk.rms)).toFixed(1)}x)`);
  log(`  camY max step:   standing-walk ${(standWalk.maxD * 1000).toFixed(1)} mm  vs crouch-walk ${(crouchWalk.maxD * 1000).toFixed(1)} mm`);
  if (errors.length) { log('\nRUNTIME ERRORS:'); errors.forEach(e => log(' ', e)); }
} catch (e) {
  console.error('FATAL', e);
  if (errors.length) errors.forEach(x => console.error(x));
  process.exit(2);
} finally {
  await browser.close();
  server.close();
}
