// Verification harness for this session's gameplay fixes. Headless Edge + puppeteer-core, deterministic
// fixed-dt stepping (see qa-harness memory). Order matters: crouch + clean-idle foot checks run on the
// settled SPAWN before any walking moves the player onto varied/edge terrain.
//   CHROME_BIN overrides the Edge path.  node tools/verify_fixes.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';

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

const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=900,600'],
});
const errors = [];
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { log(`${ok ? '  PASS' : '  FAIL'} ${name}${detail ? '  — ' + detail : ''}`); ok ? pass++ : fail++; };

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
    // Skip the (software-WebGL, slow) render during manual stepping — getWorldPosition/getWorldQuaternion
    // update the matrices they read on demand, so the samples stay accurate and stepping is ~10x faster.
    window._APP.renderer.render = () => {};
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    const EM = () => window._APP.entityManager;
    const P = () => EM().Get('Player');
    window.__pc = () => P().GetComponent('PlayerControls');
    window.__body = () => P().GetComponent('PlayerBody');
    window.__grounded = () => P().GetComponent('PlayerPhysics').canJump;
    window.__V3 = () => window.__body().modelRoot.position.constructor;
    window.__press = (code) => document.dispatchEvent(new KeyboardEvent('keydown', { code }));
    window.__release = (code) => document.dispatchEvent(new KeyboardEvent('keyup', { code }));
    window.__terrain = () => EM().Get('Level').GetComponent('Terrain');
    window.__footBones = () => { const out = {}; window.__body().model.traverse(o => { if (o.isBone && (o.name === 'foot_l' || o.name === 'foot_r')) out[o.name] = o; }); return out; };
    // Worst foot penetration this frame: how far a foot's ankle sits BELOW its planted rest height
    // (ground + ankleRest). >0 => the sole is clipping into the terrain by that many metres.
    window.__footPen = () => {
      const V3 = window.__V3(); const terr = window.__terrain(); const fb = window.__footBones();
      const ik = window.__body().footIK; const legs = ik && ik.legs ? ik.legs : [];
      const rest = {}; for (const lg of legs) { rest[lg.foot.name] = lg.ankleRest; }
      let worst = -Infinity;
      for (const name of ['foot_l', 'foot_r']) {
        const b = fb[name]; if (!b) continue;
        const w = b.getWorldPosition(new V3());
        const g = terr ? terr.HeightAt(w.x, w.z) : 0;
        worst = Math.max(worst, (rest[name] ?? 0.12) - (w.y - g));
      }
      return +worst.toFixed(4);
    };
    window.__soldier = () => { for (const e of EM().entities) { const c = e.GetComponent && e.GetComponent('UeSoldierController'); if (c) return { e, c }; } return null; };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);
  // Sample worst foot penetration over `frames`, returning {worst, atFrame, last, grounded, air} (grounded/
  // airState captured AT the worst frame, to tell a real foot-IK miss from a brief airborne crest).
  const penOver = async (frames) => page.evaluate((frames) => {
    let worst = -Infinity, atFrame = -1, last = 0, gr = null, air = null;
    for (let i = 0; i < frames; i++) {
      window.__step(1); const w = window.__footPen();
      if (w > worst) { worst = w; atFrame = i; gr = window.__grounded(); air = window.__body().airState; }
      last = w;
    }
    return { worst: +worst.toFixed(4), atFrame, last: +last.toFixed(4), grounded: gr, air };
  }, frames);

  await step(220); // settle on the ground + FootIK calibrates (needs ~30 slow frames)

  log('\n[1] runtime errors after load+settle');
  check('no console/page errors during load+settle', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n[2] movement speeds reduced');
  const sp = await page.evaluate(() => { const pc = window.__pc(); return { walk: pc.walkSpeed, sprint: +(pc.walkSpeed * pc.sprintMultiplier).toFixed(2), crouch: +(pc.walkSpeed * pc.crouchSpeedMultiplier).toFixed(2) }; });
  log('    walk=' + sp.walk + '  sprint=' + sp.sprint + '  crouch=' + sp.crouch + ' (m/s)');
  check('walk reduced (<=5.5, was 7.0)', sp.walk <= 5.5);
  check('sprint reduced (<=8, was 11.2)', sp.sprint <= 8);
  check('crouch reduced (<=2.5, was 3.5)', sp.crouch <= 2.5);

  log('\n[3] enemy AI engages when shot');
  const ai = await page.evaluate(() => {
    const s = window.__soldier(); if (!s) return { found: false };
    const player = window._APP.entityManager.Get('Player');
    s.c.stateMachine.SetState('patrol');
    const before = s.c.stateMachine.currentState.Name;
    s.e.Broadcast({ topic: 'hit', amount: 2, from: player });
    const afterPatrolHit = s.c.stateMachine.currentState.Name;
    s.c.stateMachine.SetState('chase');
    const cs = s.c.stateMachine.currentState; cs.lostTimer = 99; cs.updateTimer = 99;
    s.e.Broadcast({ topic: 'hit', amount: 2, from: player });
    return { found: true, before, afterPatrolHit, lostTimerAfter: cs.lostTimer, updateTimerAfter: cs.updateTimer };
  });
  if (!ai.found) { check('a soldier exists to test', false); }
  else {
    log('    patrol "' + ai.before + '" + hit -> "' + ai.afterPatrolHit + '"   chase lostTimer after hit=' + ai.lostTimerAfter);
    check('patrol soldier shot -> chase', ai.afterPatrolHit === 'chase');
    check('chase soldier shot -> patience (lostTimer) reset', ai.lostTimerAfter === 0);
    check('chase soldier shot -> repath (updateTimer) reset', ai.updateTimerAfter === 0);
  }

  // [4] crouch transition on the CLEAN spawn (before any walking). Measure _crouchEased (the actual
  // crouch blend — position/terrain-independent) for smoothness, plus the body-vs-capsule drop.
  log('\n[4] crouch transition (clean spawn)');
  const crouch = await page.evaluate(() => {
    const pc = window.__pc(); const body = window.__body();
    pc._crouchToggle = false; window.__step(50);
    const grounded = window.__grounded();
    const standDelta = body.modelRoot.position.y - window._APP.entityManager.Get('Player').Position.y;
    pc._crouchToggle = true;
    const eased = []; for (let i = 0; i < 50; i++) { window.__step(1); eased.push(+body._crouchEased.toFixed(4)); }
    const crouchDelta = body.modelRoot.position.y - window._APP.entityManager.Get('Player').Position.y;
    const crouchingNow = pc.crouching;   // capture WHILE crouched (before the teardown stands back up)
    // monotonic ramp + settle of the crouch blend
    let maxDrop = 0, finalEased = eased[eased.length - 1]; for (let i = 1; i < eased.length; i++) { maxDrop = Math.max(maxDrop, eased[i - 1] - eased[i]); }
    const halfFrame = eased.findIndex(v => v >= 0.5);
    pc._crouchToggle = false; window.__step(50);
    return {
      grounded, finalEased, maxDrop, halfFrame,
      bodyDrop: +(standDelta - crouchDelta).toFixed(3),   // how much lower the body sits vs the capsule when crouched
      crouching: crouchingNow, eased8: eased.filter((_, i) => i % 6 === 0),
    };
  });
  log('    grounded=' + crouch.grounded + '  crouching=' + crouch.crouching + '  _crouchEased ramp=' + JSON.stringify(crouch.eased8) + ' -> ' + crouch.finalEased);
  log('    body sits ' + crouch.bodyDrop + ' m lower vs capsule when crouched; reached 50% at frame ' + crouch.halfFrame);
  check('crouch engages (grounded + crouching)', crouch.grounded && crouch.crouching);
  check('crouch blend reaches ~1', crouch.finalEased > 0.95);
  check('crouch blend is monotonic (no backward jerk)', crouch.maxDrop < 0.01, 'maxBackStep=' + crouch.maxDrop);
  check('crouch settles promptly (50% within ~10 frames)', crouch.halfFrame >= 0 && crouch.halfFrame <= 12, 'frame=' + crouch.halfFrame);
  check('body lowers into crouch (~0.32 m)', crouch.bodyDrop > 0.2 && crouch.bodyDrop < 0.45, 'drop=' + crouch.bodyDrop);

  // [5] foot penetration. Clean-spawn idle + crouch-idle first, then walking onto varied terrain.
  log('\n[5] FootIK keeps feet on the terrain (worst penetration, m; TOL=0.035)');
  const TOL = 0.035;
  const gr = (r) => ' (grounded=' + r.grounded + ' air=' + r.air + ')';
  const rIdle = await penOver(60);
  log('    TPS idle        worst=' + rIdle.worst + ' @f' + rIdle.atFrame + gr(rIdle) + '  last=' + rIdle.last);
  await page.evaluate(() => { window.__pc()._crouchToggle = true; });
  const rCrouchIdle = await penOver(90);
  log('    crouch idle     worst=' + rCrouchIdle.worst + ' @f' + rCrouchIdle.atFrame + gr(rCrouchIdle) + '  last=' + rCrouchIdle.last);
  await page.evaluate(() => { window.__press('KeyW'); });
  const rCrouchWalk = await penOver(120);
  log('    crouch walk     worst=' + rCrouchWalk.worst + ' @f' + rCrouchWalk.atFrame + gr(rCrouchWalk) + '  last=' + rCrouchWalk.last);
  await page.evaluate(() => { window.__release('KeyW'); window.__pc()._crouchToggle = false; }); await step(40);
  await page.evaluate(() => { window.__press('KeyW'); });
  const rWalk = await penOver(160);
  await page.evaluate(() => { window.__release('KeyW'); }); await step(40);
  log('    TPS walk        worst=' + rWalk.worst + ' @f' + rWalk.atFrame + gr(rWalk) + '  last=' + rWalk.last);
  check('idle feet not clipping', rIdle.worst <= TOL, '' + rIdle.worst);
  check('crouch-idle feet not clipping', rCrouchIdle.worst <= TOL, '' + rCrouchIdle.worst);
  check('crouch-walk feet not clipping', rCrouchWalk.worst <= TOL, '' + rCrouchWalk.worst);
  check('walking feet not clipping', rWalk.worst <= TOL, '' + rWalk.worst);

  // [5b] anti-FLOAT regression guard: the corrupted calibration baked ankleRest ~0.38 (sole floating ~0.3 m
  // off the floor) and asymmetric L/R (crooked). Verify ankleRest is sane + symmetric and the planted feet
  // actually sit ON the ground (foot bone within ~ankleRest of the terrain, not floating).
  log('\n[5b] feet sit ON the ground (anti-float regression)');
  const flt = await page.evaluate(() => {
    window.__step(30);   // settle to a planted idle
    const body = window.__body(); const terr = window.__terrain(); const V3 = window.__V3();
    const ik = body.footIK; const legs = ik.legs || [];
    const rests = legs.map(l => +l.ankleRest.toFixed(3));
    const feet = {}; body.model.traverse(o => { if (o.isBone && (o.name === 'foot_l' || o.name === 'foot_r')) feet[o.name] = o; });
    let maxH = 0;
    for (const n of ['foot_l', 'foot_r']) { const b = feet[n]; if (!b) continue; const w = b.getWorldPosition(new V3()); const g = terr ? terr.HeightAt(w.x, w.z) : 0; maxH = Math.max(maxH, w.y - g); }
    return { rests, calibrated: ik._calibrated, maxFootAboveGround: +maxH.toFixed(3), maxRest: Math.max(...rests), asym: +Math.abs(rests[0] - rests[1]).toFixed(3) };
  });
  log('    ankleRest=' + JSON.stringify(flt.rests) + '  calibrated=' + flt.calibrated + '  max foot-above-ground=' + flt.maxFootAboveGround + ' m');
  check('ankleRest sane (<=0.2, not the corrupted ~0.38)', flt.maxRest <= 0.2, 'maxRest=' + flt.maxRest);
  check('ankleRest symmetric (no crooked L/R)', flt.asym < 0.02, 'asym=' + flt.asym);
  check('planted feet NOT floating (foot bone <=0.22 m above ground)', flt.maxFootAboveGround <= 0.22, flt.maxFootAboveGround + ' m');

  log('\n[6] FPS look-down forward push');
  const fps = await page.evaluate(() => {
    const pc = window.__pc(); const V3 = window.__V3();
    if (pc.cameraMode !== 'FPS') pc.ToggleCamera();
    pc.angles.x = 0; pc.UpdateRotation(); window.__step(40);
    const level = pc.camera.position.clone(); const levelEased = pc._fpsLookDownEased;
    pc.angles.x = -1.4; pc.UpdateRotation(); window.__step(40);
    const down = pc.camera.position.clone(); const downEased = pc._fpsLookDownEased;
    const fwd = new V3(0, 0, -1).applyQuaternion(pc.yaw);
    const deltaFwd = (down.x - level.x) * fwd.x + (down.z - level.z) * fwd.z;
    pc.angles.x = 0; pc.UpdateRotation(); pc.ToggleCamera(); window.__step(20);
    return { levelEased: +levelEased.toFixed(3), downEased: +downEased.toFixed(3), deltaFwd: +deltaFwd.toFixed(3), finite: [down.x, down.y, down.z].every(Number.isFinite) };
  });
  log('    eased level=' + fps.levelEased + ' -> down=' + fps.downEased + '   forward shift=' + fps.deltaFwd + ' m');
  check('look-down push ~off when level', fps.levelEased < 0.1);
  check('look-down push ~on when down', fps.downEased > 0.8);
  check('camera pushed FORWARD when looking down', fps.deltaFwd > 0.15);
  check('FPS camera position finite', fps.finite);

  // ---------- ROUND 2 FIXES ----------
  log('\n[7] terrain slope intensity raised');
  const terr = await page.evaluate(() => {
    const t = window.__terrain();
    const hs = t._heights; let mn = Infinity, mx = -Infinity; for (let i = 0; i < hs.length; i++) { mn = Math.min(mn, hs[i]); mx = Math.max(mx, hs[i]); }
    return { amplitude: t.amplitude, range: +(mx - mn).toFixed(3), mx: +mx.toFixed(3) };
  });
  log('    amplitude=' + terr.amplitude + '  height range=' + terr.range + ' m');
  check('terrain amplitude raised (>=1.0, was 0.5)', terr.amplitude >= 1.0);
  check('terrain height range stronger (>=1.5 m peak-to-peak)', terr.range >= 1.5);

  log('\n[8] FPS reload no longer pulls the camera back');
  const reload = await page.evaluate(() => {
    const pc = window.__pc(); const P = () => window._APP.entityManager.Get('Player');
    if (pc.cameraMode !== 'FPS') pc.ToggleCamera();
    pc.angles.x = 0; pc.UpdateRotation(); pc._reloading = false; window.__step(40);
    // Isolate the RELOAD pullback's contribution from the idle head-bob: at the SAME frame (no stepping),
    // re-place the FPS eye with the reload pullback fully OUT vs fully IN. With fpsReloadPullback=0 these
    // must be identical — any difference would be the reload moving the camera.
    pc._reloadEased = 0; pc.PlaceFpsEyePosition(P().Position); const out = pc.camera.position.clone();
    pc._reloadEased = 1; pc.PlaceFpsEyePosition(P().Position); const inn = pc.camera.position.clone();
    const reloadShift = out.distanceTo(inn);
    pc._reloadEased = 0; pc.ToggleCamera(); window.__step(20);
    return { pullback: pc.fpsReloadPullback, up: pc.fpsReloadUp, reloadShift: +reloadShift.toFixed(4) };
  });
  log('    fpsReloadPullback=' + reload.pullback + '  fpsReloadUp=' + reload.up + '  reload-induced camera shift=' + reload.reloadShift + ' m');
  check('reload pullback disabled (==0)', reload.pullback === 0 && reload.up === 0);
  check('reload itself moves the camera ~0 (<2 mm)', reload.reloadShift < 0.002, reload.reloadShift + ' m');

  log('\n[9] crouch -> jump: no take-off teleport, clears fast, lands standing');
  const cj = await page.evaluate(() => {
    const pc = window.__pc(); const body = window.__body();
    const eyeY = () => window._APP.entityManager.Get('Player').Position.y;
    const rootY = () => body.modelRoot.position.y;
    pc._crouchToggle = true; window.__release('Space'); window.__step(50);   // settle crouched on the ground
    const easedCrouched = +body._crouchEased.toFixed(3);
    const groundedBefore = window.__grounded();
    // Jump. Track the DECOUPLED body up-step (rootΔ - eyeΔ): the body rising NOT explained by the eye/
    // capsule rise. The old hard-snap teleported the body up by the full crouch depth (~0.24 m) in one
    // frame while the eye was still flat; the eased uncrouch-into-jump should keep this small.
    let prevRoot = rootY(), prevEye = eyeY(), maxDecoupled = 0, easedF12 = null, tookOff = false;
    window.__press('Space');
    for (let i = 0; i < 40; i++) {
      window.__step(1);
      const r = rootY(), e = eyeY();
      maxDecoupled = Math.max(maxDecoupled, (r - prevRoot) - (e - prevEye));
      prevRoot = r; prevEye = e;
      if (!window.__grounded()) tookOff = true;
      if (i === 11) easedF12 = +body._crouchEased.toFixed(3);
    }
    window.__release('Space');
    let landed = false; for (let i = 0; i < 140; i++) { window.__step(1); if (window.__grounded()) { landed = true; break; } }
    window.__step(20);
    return { easedCrouched, groundedBefore, maxDecoupled: +maxDecoupled.toFixed(3), easedF12, tookOff, landed,
      crouchingAfterLand: pc.crouching, easedAfterLand: +body._crouchEased.toFixed(3) };
  });
  log('    crouched eased=' + cj.easedCrouched + '  max DECOUPLED body up-step=' + cj.maxDecoupled + ' m  _crouchEased@f12=' + cj.easedF12 + '  tookOff=' + cj.tookOff + '  landed=' + cj.landed);
  check('was crouched + grounded before jump', cj.easedCrouched > 0.9 && cj.groundedBefore);
  check('took off + landed', cj.tookOff && cj.landed);
  check('NO take-off teleport (decoupled body step <0.1 m; was ~0.24)', cj.maxDecoupled < 0.1, cj.maxDecoupled + ' m');
  check('crouch clears fast during ascent (_crouchEased<0.25 by ~12 frames)', cj.easedF12 !== null && cj.easedF12 < 0.25, 'eased@f12=' + cj.easedF12);
  check('landed standing (not crouched)', !cj.crouchingAfterLand && cj.easedAfterLand < 0.1);

  log('\n[10] crouch-walk raises the hips vs crouch-idle (knee-pop mitigation)');
  const hip = await page.evaluate(() => {
    const pc = window.__pc(); const body = window.__body();
    // Effective crouch DROP from the body's own fields, so it isolates the crouch contribution from the
    // terrain hip-drop (which also moves modelRoot.y on slopes and would mask the lift).
    const crouchDrop = () => body.crouchModelDrop * body._crouchEased * (1 - (1 - body.crouchMoveDropScale) * body._crouchMoveRaise);
    pc._crouchToggle = true; window.__release('KeyW'); window.__step(60);
    const idleDrop = +crouchDrop().toFixed(3); const idleRaise = +body._crouchMoveRaise.toFixed(3);
    window.__press('KeyW'); window.__step(90);
    const walkDrop = +crouchDrop().toFixed(3); const walkRaise = +body._crouchMoveRaise.toFixed(3);
    window.__release('KeyW'); pc._crouchToggle = false; window.__step(50);
    return { idleDrop, walkDrop, idleRaise, walkRaise, lift: +(idleDrop - walkDrop).toFixed(3) };
  });
  log('    effective crouch drop: idle=' + hip.idleDrop + '  walk=' + hip.walkDrop + '  (hips raised ' + hip.lift + ' m)  raise idle=' + hip.idleRaise + ' walk=' + hip.walkRaise);
  check('crouch-walk raises the hips vs crouch-idle', hip.lift > 0.08, 'lift=' + hip.lift);
  check('hip-raise ~off at crouch-idle, ~on at crouch-walk', hip.idleRaise < 0.2 && hip.walkRaise > 0.7);

  log('\n[11] knee stability: calf-bone jerk (deg/frame; pop => big spikes)');
  const knee = await page.evaluate(() => {
    const pc = window.__pc(); const body = window.__body(); const V3 = window.__V3();
    const Q = body.model.quaternion.constructor;
    const calf = {}; body.model.traverse(o => { if (o.isBone && (o.name === 'calf_l' || o.name === 'calf_r')) calf[o.name] = o; });
    const sampleMaxDelta = (frames) => {
      let prevL = null, prevR = null, maxD = 0;
      for (let i = 0; i < frames; i++) {
        window.__step(1);
        const ql = calf.calf_l.getWorldQuaternion(new Q()), qr = calf.calf_r.getWorldQuaternion(new Q());
        if (prevL) { maxD = Math.max(maxD, prevL.angleTo(ql) * 180 / Math.PI, prevR.angleTo(qr) * 180 / Math.PI); }
        prevL = ql; prevR = qr;
      }
      return +maxD.toFixed(2);
    };
    // crouch ENTRY snap (#2): stand idle, then crouch and sample the first ~0.3s — the single-ease frame-1
    // step used to snap the calf ~23 deg in one frame; the cascaded S-curve ease should bend it in smoothly.
    pc._crouchToggle = false; window.__release('KeyW'); window.__step(55);
    pc._crouchToggle = true;
    const crouchEntryMax = sampleMaxDelta(18);
    window.__step(40);   // settle crouched
    // crouch-walk (the reported pop scenario) — already crouched
    window.__press('KeyW'); window.__step(40);
    const crouchWalkMax = sampleMaxDelta(120);
    // standing-walk reference (same path, no crouch)
    window.__release('KeyW'); pc._crouchToggle = false; window.__step(40);
    window.__press('KeyW'); window.__step(40);
    const standWalkMax = sampleMaxDelta(120);
    window.__release('KeyW'); window.__step(30);
    // crouch-idle (should be near-still knees)
    pc._crouchToggle = true; window.__step(50);
    const crouchIdleMax = sampleMaxDelta(60);
    pc._crouchToggle = false; window.__step(40);
    return { crouchEntryMax, crouchWalkMax, standWalkMax, crouchIdleMax };
  });
  log('    max calf jerk: crouch-ENTRY=' + knee.crouchEntryMax + '  crouch-walk=' + knee.crouchWalkMax + '  stand-walk=' + knee.standWalkMax + '  crouch-idle=' + knee.crouchIdleMax + ' deg/frame');
  check('crouch ENTRY no knee snap (<10 deg/frame; was ~23)', knee.crouchEntryMax < 10, knee.crouchEntryMax + ' deg/f');
  check('crouch-idle knees near-stable (<6 deg/frame)', knee.crouchIdleMax < 6, knee.crouchIdleMax + ' deg/f');
  check('crouch-walk knees not popping (<= stand-walk + 8 deg/frame)', knee.crouchWalkMax <= knee.standWalkMax + 8, 'cw=' + knee.crouchWalkMax + ' sw=' + knee.standWalkMax);

  log('\n[final] runtime errors over the whole run');
  check('zero runtime errors', errors.length === 0, errors.length + ' errors');
  if (errors.length) { errors.slice(0, 20).forEach((e) => log('    ' + e)); }

  log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  if (errors.length) { log('--- page errors ---'); errors.slice(0, 20).forEach((x) => log(x)); }
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
