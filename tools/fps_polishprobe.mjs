// FPS polish probe — objective before/after signal for the 6 FPS fixes.
//   A) idle->aim PING-PONG: per-frame gun screen Y while aim engages (reversal = ping-pong).
//   B) MOVING vs IDLE aim gun position (stand + crouch): mean + bob range.
//   C) CROUCH-aim HEIGHT vs STAND-aim, reference captured at LEVEL pitch (matches real play).
//   D) RELOAD hand<->gun CONTACT distances over a reload (hands missing the gun = large).
//   node tools/fps_polishprobe.mjs
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
const PORT = 8099;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=900,700'] });
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
    window.__body = () => window._APP.entityManager.Get('Player').GetComponent('PlayerBody');
    window.__toFPS = () => { const pc = window.__pc(); if (pc.cameraMode !== 'FPS') pc.ToggleCamera(); };
    window.__aim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__pitch = (rad) => { const pc = window.__pc(); pc.angles.x = rad; pc.UpdateRotation(); };
    window.__crouch = (on) => { const pc = window.__pc(); pc._crouchToggle = on; };
    window.__move = (on) => {
      const code = 'KeyW';
      document.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: 'w', bubbles: true }));
    };
    window.__reload = () => { window.__body().parent.Broadcast({ topic: 'weapon.reload' }); };
    // Strip ALL enemies so combat (enemy fire -> player hurt-flinch jolts the gun/camera) can't contaminate
    // the pose-steadiness measurements. Deferred removal flushes on the next Step.
    window.__nocombat = () => {
      const em = window._APP.entityManager;
      const kill = em.entities.filter(e => /^(UeSoldier|Mutant)/.test(e.Name || ''));
      kill.forEach(e => em.Remove(e));
      return kill.length;
    };
    // Gun screen position (NDC). rearY = the receiver/weaponPivot origin projected; muzY = muzzle.
    window.__gun = () => {
      const body = window.__body(); const pc = window.__pc(); const cam = pc.camera;
      const ik = body.weaponAimIK;
      const V3 = body.weaponPivot.position.constructor;
      const rearW = new V3(); body.weaponPivot.getWorldPosition(rearW);
      const r = rearW.project(cam);
      const out = { rearY: +r.y.toFixed(4), rearX: +r.x.toFixed(4),
        lockW: +(body._fpsAimLockW ?? 0).toFixed(3), poseW: +(body._fpsAimPoseW ?? 0).toFixed(3),
        crouch: +(body._crouchEased ?? 0).toFixed(3), spd: +pc.HorizontalSpeed.toFixed(2),
        lower: body.lowerState };
      const d = ik && ik._debug ? ik._debug : null;
      if (d && d.muzzle) out.muzY = +d.muzzle.clone().project(cam).y.toFixed(4);
      return out;
    };
    // Hand<->gun contact (metres): distance from each hand bone to its captured grip socket on the gun.
    window.__contact = () => {
      const body = window.__body(); const ik = body.weaponAimIK;
      const pivot = body.weaponPivot; pivot.updateWorldMatrix(true, false);
      const V3 = pivot.position.constructor;
      const res = {};
      if (ik.bones.hand_l && ik._socketsCaptured) {
        const sock = ik.leftGripLocal.clone().applyMatrix4(pivot.matrixWorld);
        const hand = new V3(); ik.bones.hand_l.getWorldPosition(hand);
        res.L = +hand.distanceTo(sock).toFixed(4);
      }
      if (ik.bones.hand_r && ik._socketsCaptured) {
        const sock = ik.rightGripLocal.clone().applyMatrix4(pivot.matrixWorld);
        const hand = new V3(); ik.bones.hand_r.getWorldPosition(hand);
        res.R = +hand.distanceTo(sock).toFixed(4);
      }
      res.oneShot = body.oneShot;
      return res;
    };
  });
  const killed = await page.evaluate(() => window.__nocombat());
  log(`(removed ${killed} enemies — no combat contamination)`);
  await page.evaluate(() => window.__step(150));
  await page.evaluate(() => window.__toFPS());
  await page.evaluate(() => window.__step(40));

  const stats = (arr) => {
    const n = arr.length; const mean = arr.reduce((a, b) => a + b, 0) / n;
    const min = Math.min(...arr), max = Math.max(...arr);
    return { mean: +mean.toFixed(4), min: +min.toFixed(4), max: +max.toFixed(4), range: +(max - min).toFixed(4) };
  };

  // ---------- A) idle -> aim PING-PONG ----------
  for (const pitch of [0, -0.4]) {
    await page.evaluate(() => window.__aim(false));
    await page.evaluate((p) => window.__pitch(p), pitch);
    await page.evaluate(() => window.__step(60));   // settle hip pose
    await page.evaluate(() => window.__aim(true));
    const series = [];
    for (let i = 0; i < 36; i++) {
      await page.evaluate(() => window.__step(1));
      series.push(await page.evaluate(() => window.__gun()));
    }
    // Detect reversal in rearY: count direction changes after smoothing.
    const ys = series.map(s => s.rearY);
    let dirChanges = 0, prevDir = 0;
    for (let i = 1; i < ys.length; i++) {
      const dy = ys[i] - ys[i - 1];
      if (Math.abs(dy) < 0.0015) continue;
      const dir = Math.sign(dy);
      if (prevDir !== 0 && dir !== prevDir) dirChanges++;
      prevDir = dir;
    }
    log(`\n[A] idle->aim PING-PONG  pitch=${pitch}  rearY dir-reversals=${dirChanges}  (0 = monotonic/smooth)`);
    log(`    rearY: ${ys.map(v => v.toFixed(3)).join(' ')}`);
    log(`    final rearY=${ys[ys.length - 1]}  lockW=${series[series.length - 1].lockW}  poseW=${series[series.length - 1].poseW}`);
  }

  // ---------- B) MOVING vs IDLE aim gun position ----------
  for (const crouch of [false, true]) {
    await page.evaluate(() => { window.__aim(true); window.__pitch(0); });
    await page.evaluate((c) => window.__crouch(c), crouch);
    await page.evaluate(() => window.__step(80));   // settle aim + crouch (also captures stance ref at level)
    const idle = [];
    for (let i = 0; i < 24; i++) { await page.evaluate(() => window.__step(1)); idle.push(await page.evaluate(() => window.__gun())); }
    await page.evaluate(() => window.__move(true));
    await page.evaluate(() => window.__step(45));    // accelerate to jog
    const mov = [];
    for (let i = 0; i < 36; i++) { await page.evaluate(() => window.__step(1)); mov.push(await page.evaluate(() => window.__gun())); }
    await page.evaluate(() => window.__move(false));
    await page.evaluate(() => window.__step(30));
    const iy = stats(idle.map(s => s.rearY)), my = stats(mov.map(s => s.rearY));
    log(`\n[B] ${crouch ? 'CROUCH' : 'STAND'} aim  IDLE rearY mean=${iy.mean} range=${iy.range}  |  MOVING(spd~${mov[mov.length - 1].spd}, ${mov[mov.length - 1].lower}) rearY mean=${my.mean} range=${my.range}`);
    log(`    drift(mov.mean - idle.mean)=${(my.mean - iy.mean).toFixed(4)}  moving bob range=${my.range}  (want both ~0)`);
  }

  // ---------- C) CROUCH-aim HEIGHT vs STAND-aim (reference captured at LEVEL) ----------
  await page.evaluate(() => { window.__aim(true); window.__pitch(0); window.__crouch(false); });
  await page.evaluate(() => window.__step(90));   // stand+aim at level: stance ref captured pitch-free
  const standG = await page.evaluate(() => window.__gun());
  await page.evaluate(() => window.__crouch(true));
  await page.evaluate(() => window.__step(90));   // crouch while staying level
  const crouchG = await page.evaluate(() => window.__gun());
  log(`\n[C] LEVEL aim height  STAND rearY=${standG.rearY} muzY=${standG.muzY}  CROUCH rearY=${crouchG.rearY} muzY=${crouchG.muzY}`);
  log(`    crouch-vs-stand rearY delta=${(crouchG.rearY - standG.rearY).toFixed(4)}  (negative = crouch gun sits LOWER on screen)`);

  // ---------- D) RELOAD hand<->gun CONTACT ----------
  await page.evaluate(() => { window.__crouch(false); window.__aim(true); window.__pitch(0); });
  await page.evaluate(() => window.__step(90));
  const before = await page.evaluate(() => window.__contact());
  await page.evaluate(() => window.__reload());
  const rl = [];
  for (let i = 0; i < 110; i++) {
    await page.evaluate(() => window.__step(1));
    if (i % 8 === 0) rl.push({ i, ...(await page.evaluate(() => window.__contact())) });
  }
  await page.evaluate(() => window.__step(40));
  const after = await page.evaluate(() => window.__contact());
  log(`\n[D] RELOAD-while-aiming hand<->gun contact (m). before L=${before.L} R=${before.R}`);
  for (const s of rl) log(`    f${String(s.i).padStart(3)} oneShot=${String(s.oneShot)}  L=${s.L}  R=${s.R}`);
  log(`    after  L=${after.L} R=${after.R}  (want contact ~constant & small THROUGHOUT; large mid-reload = hands miss the gun)`);

  // ---------- E) CROUCH-IDLE loop seam (NOT aiming): per-frame camera Y step; spike at the clip wrap = seam pop ----------
  await page.evaluate(() => { window.__aim(false); window.__pitch(0); window.__move(false); window.__crouch(true); });
  await page.evaluate(() => window.__step(120));   // settle into crouch-idle
  await page.evaluate(() => {
    window.__cl = () => {
      const body = window.__body(); const pc = window.__pc();
      const a = body.upperActions && body.upperActions['crouchIdle'];
      return { y: +pc.camera.position.y.toFixed(5), t: a ? +a.time.toFixed(3) : -1,
        dur: a ? +a.getClip().duration.toFixed(3) : -1, lower: body.lowerState };
    };
  });
  const cl = [];
  for (let i = 0; i < 160; i++) { await page.evaluate(() => window.__step(1)); cl.push(await page.evaluate(() => window.__cl())); }
  // Per-frame camera Y step; a loop wrap (action.time resets to ~0) with a big |dY| is the seam pop.
  let maxStep = 0, maxAt = -1, wrapStep = 0;
  for (let i = 1; i < cl.length; i++) {
    const dy = Math.abs(cl[i].y - cl[i - 1].y);
    if (dy > maxStep) { maxStep = dy; maxAt = i; }
    if (cl[i].t < cl[i - 1].t) wrapStep = Math.max(wrapStep, dy);   // clip wrapped this frame
  }
  log(`\n[E] CROUCH-IDLE (not aiming) loop  dur=${cl[0].dur}s  state=${cl[cl.length-1].lower}`);
  log(`    max camera-Y step=${maxStep.toFixed(5)} at frame ${maxAt}  |  max step AT a clip wrap=${wrapStep.toFixed(5)}  (big wrap step = loop seam pop)`);

  // ---------- F) CROUCH-IDLE GUN steadiness, isolated (enter crouch from a CLEAN standing idle, no prior jog) ----------
  // F1: not aiming (hip gun rides crouch-idle arms). F2: aiming (ADS gun should be pinned steady).
  for (const aiming of [false, true]) {
    await page.evaluate(() => { window.__move(false); window.__aim(false); window.__pitch(0); window.__crouch(false); });
    await page.evaluate(() => window.__step(60));          // clean standing idle
    if (aiming) { await page.evaluate(() => window.__aim(true)); await page.evaluate(() => window.__step(70)); } // settle ADS + capture ref while STANDING idle
    await page.evaluate(() => window.__crouch(true));
    await page.evaluate(() => window.__step(90));          // settle crouch
    const samp = [];
    for (let i = 0; i < 60; i++) { await page.evaluate(() => window.__step(1)); samp.push(await page.evaluate(() => window.__gun())); }
    const s = stats(samp.map(x => x.rearY));
    log(`\n[F] CROUCH-IDLE ${aiming ? 'AIMING' : 'hip(not aiming)'} gun rearY mean=${s.mean} range=${s.range}  (want range ~0; large = idle-loop glitch)`);
  }

  // ---------- G) CROUCH pressed MID-ADS-RAISE (must match the settled-then-crouch framing, not a half-raised one) ----------
  // First establish a settled standing-aim reference, release, then re-aim and crouch only ~4 frames later
  // (while the ADS is still raising). The crouch framing must equal the clean settled-then-crouch framing.
  await page.evaluate(() => { window.__move(false); window.__crouch(false); window.__pitch(0); window.__aim(true); });
  await page.evaluate(() => window.__step(90));          // settled standing aim -> commits a clean reference
  const cleanCrouch = await (async () => {
    await page.evaluate(() => window.__crouch(true)); await page.evaluate(() => window.__step(90));
    const g = await page.evaluate(() => window.__gun());
    await page.evaluate(() => { window.__crouch(false); window.__aim(false); }); await page.evaluate(() => window.__step(60));
    return g.rearY;
  })();
  // Mid-raise: re-aim and crouch 4 frames in.
  await page.evaluate(() => window.__aim(true));
  await page.evaluate(() => window.__step(4));
  await page.evaluate(() => window.__crouch(true));
  await page.evaluate(() => window.__step(120));
  const midCrouch = await page.evaluate(() => window.__gun());
  log(`\n[G] CROUCH mid-ADS-raise  clean settled-then-crouch rearY=${cleanCrouch}  |  crouch-mid-raise rearY=${midCrouch.rearY}`);
  log(`    delta=${(midCrouch.rearY - cleanCrouch).toFixed(4)}  (want ~0; large = a half-raised reference was frozen)`);

} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
