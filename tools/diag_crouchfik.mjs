// Diagnostic: hunts the intermittent crouch-walk pose glitch. Crouches, then crouch-walks a long
// CIRCLE over varied terrain (steering the look yaw each frame) and records, per frame: FootIK
// master weight, grounded flag, leg-bone world-rotation jerk, camera-Y delta, capsule vy.
// The hypothesis under test: brief IsGrounded flickers (terrain crest hops) gate FootIK's `enabled`
// off → its weight dips → the crouch knee-bend (which IS FootIK) straightens + re-bends = the glitch,
// simultaneous with the capsule/camera bump from the same crest. Reports weight-dip frames, top jerk
// events with ±4 frames of context, and correlation between dips and jerk spikes.
//   node tools/diag_crouchfik.mjs
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
const PORT = 8095;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/crouchfik-chrome', '--window-size=900,600'],
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
    // Long crouch-walk with steady steering (wide circle over varied terrain).
    window.__hunt = (frames, yawRate) => {
      const bd = window.__body(), pc = window.__pc(), ph = window.__ph();
      const bones = {}; bd.model.traverse(o => { if (o.isBone && /^(calf|thigh)_(l|r)$/.test(o.name)) bones[o.name] = o; });
      const Q = bd.modelRoot.quaternion.constructor;
      const names = Object.keys(bones);
      const cur = {}, prv = {};
      for (const n of names) { cur[n] = new Q(); prv[n] = new Q(); bones[n].getWorldQuaternion(prv[n]); }
      const out = [];
      for (let i = 0; i < frames; i++) {
        pc.angles.y -= yawRate; pc.UpdateRotation();
        window.__step(1);
        let jerk = 0;
        for (const n of names) {
          bones[n].getWorldQuaternion(cur[n]);
          jerk = Math.max(jerk, prv[n].angleTo(cur[n]) * 180 / Math.PI);
          prv[n].copy(cur[n]);
        }
        const v = ph.body.getLinearVelocity();
        out.push({
          fw: +bd.footIK._weight.toFixed(3),
          cj: ph.canJump ? 1 : 0,
          air: bd.airState ? 1 : 0,
          jerk: +jerk.toFixed(1),
          camY: +window._APP.camera.position.y.toFixed(5),
          vy: +v.y().toFixed(2),
          ce: +bd._crouchEased.toFixed(2),
          loco: bd.lowerState,
        });
      }
      return out;
    };
  });

  const step = (n) => page.evaluate((n) => window.__step(n), n);
  const press = (c) => page.evaluate((c) => window.__press(c), c);

  await step(240);   // settle + FootIK calibration
  await press('KeyC'); await step(1); await page.evaluate(() => window.__release('KeyC'));
  await step(60);    // crouch fully in
  await press('KeyW'); await step(20);

  const tr = await page.evaluate(() => window.__hunt(1500, 0.012));   // ~25 s circling crouch-walk

  // --- Phase 2: TOGGLE crouch every 75 frames while WALKING over varied terrain (the transition
  // is the suspect: SetCrouched zeroes vy mid-slope; FootIK's floor weight swings 0<->1 mid-stride).
  const tr3 = await page.evaluate(() => {
    const pc = window.__pc();
    const bd = window.__body(), ph = window.__ph();
    const bones = {}; bd.model.traverse(o => { if (o.isBone && /^(calf|thigh)_(l|r)$/.test(o.name)) bones[o.name] = o; });
    const Q = bd.modelRoot.quaternion.constructor;
    const names = Object.keys(bones);
    const cur = {}, prv = {};
    for (const n of names) { cur[n] = new Q(); prv[n] = new Q(); bones[n].getWorldQuaternion(prv[n]); }
    const out = [];
    for (let i = 0; i < 1500; i++) {
      if (i % 75 === 0) { pc._crouchToggle = !pc._crouchToggle; }   // toggle crouch mid-walk
      pc.angles.y -= 0.012; pc.UpdateRotation();
      window.__step(1);
      let jerk = 0;
      for (const n of names) {
        bones[n].getWorldQuaternion(cur[n]);
        jerk = Math.max(jerk, prv[n].angleTo(cur[n]) * 180 / Math.PI);
        prv[n].copy(cur[n]);
      }
      const v = ph.body.getLinearVelocity();
      const o = ph.body.getWorldTransform().getOrigin();
      out.push({
        fw: +bd.footIK._weight.toFixed(3), cj: ph.canJump ? 1 : 0, air: bd.airState ? 1 : 0,
        jerk: +jerk.toFixed(1), camY: +window._APP.camera.position.y.toFixed(5),
        vy: +v.y().toFixed(2), py: +o.y().toFixed(4), crP: ph.crouched ? 1 : 0,
        ce: +bd._crouchEased.toFixed(2), loco: bd.lowerState, tog: i % 75 === 0 ? 1 : 0,
      });
    }
    return out;
  });

  // Analysis
  let dipFrames = 0, minFw = 2, cjDrops = 0, airFrames = 0;
  const events = [];
  for (let i = 1; i < tr.length; i++) {
    if (tr[i].fw < 0.95) { dipFrames++; minFw = Math.min(minFw, tr[i].fw); }
    if (tr[i].cj === 0 && tr[i - 1].cj === 1) cjDrops++;
    if (tr[i].air) airFrames++;
    events.push({ i, jerk: tr[i].jerk });
  }
  events.sort((a, b) => b.jerk - a.jerk);
  const top = events.slice(0, 5);
  // correlation: of the top-5 jerk events, how many sit within 6 frames of a weight dip or cj drop?
  const nearDip = (i) => {
    for (let k = Math.max(0, i - 6); k < Math.min(tr.length, i + 7); k++) {
      if (tr[k].fw < 0.95 || tr[k].cj === 0) return true;
    }
    return false;
  };
  // Distribution of per-frame leg jerk over the steady crouch-walk (the sustained "skate/snap" metric).
  const js = events.map(e => e.jerk).sort((a, b) => a - b);
  const pct = (p) => js[Math.min(js.length - 1, Math.floor(p * js.length))];
  const mean = js.reduce((a, b) => a + b, 0) / js.length;
  const over6 = js.filter(j => j > 6).length, over9 = js.filter(j => j > 9).length;
  log(`\n=== crouch-walk hunt (1500 frames, circling) ===`);
  log(`  leg jerk: mean ${mean.toFixed(2)}°  median ${pct(0.5).toFixed(1)}°  p95 ${pct(0.95).toFixed(1)}°  max ${js[js.length-1]}°  | frames >6°: ${over6}  >9°: ${over9}`);
  log(`  FootIK weight dips (<0.95): ${dipFrames} frames, min ${minFw === 2 ? 'none' : minFw}`);
  log(`  grounded(canJump) drops: ${cjDrops}   airState frames: ${airFrames}`);
  log(`  top-5 leg jerk events (°/frame):`);
  for (const e of top) {
    log(`   f${e.i} jerk=${e.jerk}°  nearDip/groundedDrop=${nearDip(e.i)}`);
    for (let k = Math.max(0, e.i - 3); k < Math.min(tr.length, e.i + 3); k++) {
      const s = tr[k];
      log(`     f${k} fw=${s.fw} cj=${s.cj} air=${s.air} vy=${String(s.vy).padStart(6)} jerk=${String(s.jerk).padStart(5)} camYd=${k ? ((s.camY - tr[k-1].camY) * 1000).toFixed(1) : '0'}mm ${s.loco}`);
    }
  }
  // Phase-2/3 analysis: worst camera step + worst jerk near each toggle vs away from toggles.
  const analyze2 = (name, tr) => {
    const toggles = [];
    tr.forEach((s, i) => { if (s.tog) toggles.push(i); });
    let nearJerk = 0, nearCam = 0, farJerk = 0, farCam = 0, nearAt = -1, nearCamAt = -1;
    for (let i = 1; i < tr.length; i++) {
      const d = Math.abs(tr[i].camY - tr[i - 1].camY) * 1000;
      const isNear = toggles.some(tf => i >= tf && i < tf + 20);
      if (isNear) {
        if (tr[i].jerk > nearJerk) { nearJerk = tr[i].jerk; nearAt = i; }
        if (d > nearCam) { nearCam = d; nearCamAt = i; }
      } else {
        farJerk = Math.max(farJerk, tr[i].jerk); farCam = Math.max(farCam, d);
      }
    }
    log(`\n=== ${name} ===`);
    log(`  near toggles (20f window): max jerk ${nearJerk}°/f at f${nearAt}, max camY step ${nearCam.toFixed(1)} mm/f at f${nearCamAt}`);
    log(`  away from toggles:         max jerk ${farJerk}°/f, max camY step ${farCam.toFixed(1)} mm/f`);
    // dump context around the worst near-toggle jerk
    if (nearAt > 0) {
      log('  worst-jerk context:');
      for (let k = Math.max(0, nearAt - 6); k < Math.min(tr.length, nearAt + 4); k++) {
        const s = tr[k];
        log(`   f${k} tog=${s.tog ?? 0} crP=${s.crP ?? '-'} ce=${s.ce} fw=${s.fw} cj=${s.cj} vy=${String(s.vy).padStart(6)} py=${s.py ?? '-'} jerk=${String(s.jerk).padStart(5)} camYd=${k ? ((s.camY - tr[k-1].camY) * 1000).toFixed(1) : '0'}mm ${s.loco}`);
      }
    }
    if (nearCamAt > 0 && Math.abs(nearCamAt - nearAt) > 6) {
      log('  worst-camera context:');
      for (let k = Math.max(0, nearCamAt - 6); k < Math.min(tr.length, nearCamAt + 4); k++) {
        const s = tr[k];
        log(`   f${k} tog=${s.tog ?? 0} crP=${s.crP ?? '-'} ce=${s.ce} fw=${s.fw} cj=${s.cj} vy=${String(s.vy).padStart(6)} py=${s.py ?? '-'} jerk=${String(s.jerk).padStart(5)} camYd=${k ? ((s.camY - tr[k-1].camY) * 1000).toFixed(1) : '0'}mm ${s.loco}`);
      }
    }
  };
  analyze2('TOGGLE crouch every 75f while walking (phase 3)', tr3);
  if (errors.length) { log('\nRUNTIME ERRORS:'); errors.forEach(e => log(' ', e)); }
} catch (e) {
  console.error('FATAL', e);
  if (errors.length) errors.forEach(x => console.error(x));
  process.exit(2);
} finally {
  await browser.close();
  server.close();
}
