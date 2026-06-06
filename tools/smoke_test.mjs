// Headless smoke test for the combat/ragdoll/AI/roll changes. Boots the real game in
// Chrome for Testing, runs the loop, then exercises the new paths and asserts no
// runtime errors are thrown:
//   * boot + ~2.5s of gameplay (entities build, physics + render loop run)
//   * kill a soldier AND the beast (broadcast a lethal 'hit') -> ragdoll builds + simulates
//   * fire a player dodge roll (PlayerControls + PlayerBody animation + i-frames)
//   * a few more seconds so ragdoll world-collision + AI repositioning tick
// Exits non-zero (and prints the errors) if anything throws.
//
//   node tools/smoke_test.mjs
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
const PORT = 8078;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/smoke-chrome', '--window-size=900,600'],
});
const errors = [];
const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE.ERROR: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

  log('loading game…');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });

  log('starting game…');
  await page.evaluate(() => document.getElementById('start_game').click());
  // EntitySetup runs after the menu/loading fades (~900ms loading + fades). Wait for entities.
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });

  // Headless Chrome throttles requestAnimationFrame hard when the page isn't visible, so the game
  // loop crawls. Cancel it and drive the SAME Step(dt) deterministically — 60 fps worth of sim per
  // call — so timing-dependent logic (roll timer, physics settle, ragdoll sim) actually advances.
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);

  await step(150);   // ~2.5s: settle the player onto the floor, AI spins up + starts maneuvering

  const setupInfo = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const names = em.entities.map((e) => e.Name);
    const pc = em.Get('Player').GetComponent('PlayerControls');
    // Sample the soldiers' AI states + per-instance combat style (variety check).
    const soldiers = em.entities.filter((e) => /UeSoldier/.test(e.Name)).map((e) => {
      const c = e.GetComponent('UeSoldierController');
      const st = c.stateMachine && c.stateMachine.currentState && c.stateMachine.currentState.Name;
      return { state: st, faction: c.faction, aggr: +c.aggression.toFixed(2), range: +c.preferredRange.toFixed(1) };
    });
    return { count: em.entities.length, names, grounded: pc.IsGrounded, mode: pc.cameraMode, soldiers };
  });
  log('entities:', setupInfo.count, JSON.stringify(setupInfo.names));
  log('player grounded:', setupInfo.grounded, 'camera:', setupInfo.mode);
  log('soldiers:', JSON.stringify(setupInfo.soldiers));

  // Verify soldier RUN-AND-GUN: an alive soldier has the directional locomotion + shoot-overlay
  // layers, and can fire (shoot overlay on the torso) while strafing (a directional jog on the legs,
  // moving). Driven directly (bypassing the FSM/visibility) so it's deterministic.
  const rng = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const alive = em.entities.filter((e) => /UeSoldier/.test(e.Name))
      .map((e) => e.GetComponent('UeSoldierController')).find((c) => c && !c.dead);
    if (!alive) return { ok: false, reason: 'no alive soldier' };
    const c = alive;
    const hasDirLegs = !!(c.lowerActions && c.lowerActions.jogF && c.lowerActions.jogB && c.lowerActions.jogL && c.lowerActions.jogR && c.lowerActions.idle);
    const hasShootUpper = !!(c.upperActions && c.upperActions.shoot);
    // Force a strafe-while-firing: face a far target, fire, and walk laterally along a straight path.
    c.target = em.Get('Player');
    c.combatFacing = true;
    c.SetMoveIntent(c.combatMoveSpeed);
    c.BeginFire();
    const p = c.position;
    c.path = [{ x: p.x + 4, y: p.y, z: p.z }, { x: p.x + 9, y: p.y, z: p.z }];
    let firedWhileMoving = false, jogWhileFiring = false, maxSpeed = 0;
    for (let i = 0; i < 45; i++) {
      c.mixer.update(1 / 60);
      c.Locomote(1 / 60);
      c.UpdateLocomotionAnim();
      c.UpdateLocoTimeScale();
      maxSpeed = Math.max(maxSpeed, c.currentSpeed);
      if (c.firing && c.currentSpeed > 0.3) firedWhileMoving = true;
      if (c.firing && c.IsJogState(c.lowerState)) jogWhileFiring = true;
    }
    return { ok: true, hasDirLegs, hasShootUpper, firing: !!c.firing, firedWhileMoving, jogWhileFiring,
             lowerState: c.lowerState, upperState: c.upperState, maxSpeed: +maxSpeed.toFixed(2) };
  });
  log('soldier run-and-gun:', JSON.stringify(rng));

  log('killing a soldier + the beast (ragdoll)…');
  await page.evaluate(() => {
    const em = window._APP.entityManager;
    const soldier = em.entities.find((e) => /UeSoldier/.test(e.Name));
    const beast = em.entities.find((e) => /Mutant/.test(e.Name));
    if (soldier) soldier.Broadcast({ topic: 'hit', amount: 999 });
    if (beast) beast.Broadcast({ topic: 'hit', amount: 999 });
  });
  // Capture each ragdoll's bounding-box height right after death, then again after simulating, to
  // confirm it actually MOVES/settles (no NaN, no freeze-on-spawn).
  const ragStart = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const sc = em.entities.find((e) => /UeSoldier/.test(e.Name)).GetComponent('UeSoldierController');
    const node0 = sc.ragdoll && sc.ragdoll.nodes && sc.ragdoll.nodes[0];
    return { built: !!sc.ragdoll, y0: node0 ? +node0.p.y.toFixed(3) : null };
  });
  await step(120);   // ~2s of ragdoll sim (world collision, bounce, settle)
  const ragInfo = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const soldier = em.entities.find((e) => /UeSoldier/.test(e.Name));
    const beast = em.entities.find((e) => /Mutant/.test(e.Name));
    const sc = soldier.GetComponent('UeSoldierController');
    const bc = beast.GetComponent('CharacterController');
    const n0 = sc.ragdoll && sc.ragdoll.nodes && sc.ragdoll.nodes[0];
    const finite = n0 ? (Number.isFinite(n0.p.x) && Number.isFinite(n0.p.y) && Number.isFinite(n0.p.z)) : false;
    return { soldierRagdoll: !!sc.ragdoll, beastRagdoll: !!bc.ragdoll,
             soldierFinite: finite, soldierY: n0 ? +n0.p.y.toFixed(3) : null };
  });
  log('ragdoll start y0:', ragStart.y0, '-> after sim y:', ragInfo.soldierY, 'finite:', ragInfo.soldierFinite);

  log('triggering player dodge roll (grounded TryStartRoll)…');
  const rollInfo = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const pc = player.GetComponent('PlayerControls');
    const body = player.GetComponent('PlayerBody');
    pc._rollCooldownTimer = 0;
    pc.TryStartRoll();   // the real path (requires grounded)
    return { started: !!pc.rolling, bodyRolling: !!body.rolling,
             hasRollAction: !!(body.lowerActions && body.lowerActions['roll']) };
  });
  log('roll started:', JSON.stringify(rollInfo));
  // i-frames must be active on the VERY FIRST roll frame (rollIFrameStart = 0.0).
  await step(1);
  const firstFrame = await page.evaluate(() => {
    const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    return { invuln: !!pc.invulnerable };
  });
  log('first-frame i-frame:', JSON.stringify(firstFrame));
  // Sample i-frames mid-roll, then run past the roll duration.
  await step(20);
  const midRoll = await page.evaluate(() => {
    const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    return { rolling: !!pc.rolling, invuln: !!pc.invulnerable };
  });
  log('mid-roll:', JSON.stringify(midRoll));
  await step(70);   // > rollDuration: the roll must have released by now
  const postRoll = await page.evaluate(() => {
    const player = window._APP.entityManager.Get('Player');
    const pc = player.GetComponent('PlayerControls');
    const body = player.GetComponent('PlayerBody');
    return { stillRolling: !!pc.rolling, invuln: !!pc.invulnerable, bodyRolling: !!body.rolling };
  });
  log('post-roll (should have ended):', JSON.stringify(postRoll));

  await step(200);   // extra time: AI reposition cycles + ragdolls keep tumbling, then SETTLE+SLEEP

  // Ragdoll should have come to REST and entered its sleep state (perf gate), with finite positions.
  // Also MEASURE the residual per-frame centroid motion of the (settled) corpse so the sleep
  // threshold can be set correctly above the verlet's inherent jitter.
  const centroidOf = () => page.evaluate(() => {
    const em = window._APP.entityManager;
    const sc = em.entities.find((e) => /UeSoldier/.test(e.Name)).GetComponent('UeSoldierController');
    const r = sc.ragdoll; if (!r || r._asleep || !r.nodes) return null;
    let cx = 0, cy = 0, cz = 0; for (const n of r.nodes) { cx += n.p.x; cy += n.p.y; cz += n.p.z; }
    const k = 1 / r.nodes.length; return [cx * k, cy * k, cz * k];
  });
  const c1 = await centroidOf();
  await step(1);
  const c2 = await centroidOf();
  let residualSq = null;
  if (c1 && c2) { const dx = c2[0]-c1[0], dy = c2[1]-c1[1], dz = c2[2]-c1[2]; residualSq = dx*dx+dy*dy+dz*dz; }
  const settle = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const sc = em.entities.find((e) => /UeSoldier/.test(e.Name)).GetComponent('UeSoldierController');
    const n0 = sc.ragdoll && sc.ragdoll.nodes && sc.ragdoll.nodes[0];
    return { asleep: !!(sc.ragdoll && sc.ragdoll._asleep),
             stillTime: sc.ragdoll ? +(sc.ragdoll._stillTime || 0).toFixed(3) : null,
             finite: n0 ? (Number.isFinite(n0.p.x) && Number.isFinite(n0.p.y) && Number.isFinite(n0.p.z)) : false,
             y: n0 ? +n0.p.y.toFixed(3) : null };
  });
  log('ragdoll settle:', JSON.stringify(settle), 'residual-centroid-motion²:', residualSq === null ? '(asleep)' : residualSq.toExponential(2));

  // ---- verdicts ----
  let ok = true;
  const fail = (m) => { ok = false; log('ASSERT FAIL:', m); };
  if (setupInfo.count < 6) fail('too few entities');
  if (!setupInfo.grounded) fail('player never settled on the ground (physics/Step issue)');
  if (!ragStart.built) fail('soldier ragdoll not built');
  if (!ragInfo.beastRagdoll) fail('beast ragdoll not built');
  if (!ragInfo.soldierFinite) fail('ragdoll produced non-finite (NaN) positions');
  if (!settle.finite) fail('ragdoll non-finite after long sim (wall/floor collision instability)');
  if (!settle.asleep) log('WARN: ragdoll not asleep yet (perf gate best-effort; depends where the corpse landed)');
  if (!rng.ok || !rng.hasDirLegs) fail('soldier missing directional locomotion layers (jogF/B/L/R)');
  if (!rng.ok || !rng.hasShootUpper) fail('soldier missing shoot upper-body overlay');
  if (!rng.firedWhileMoving) fail('soldier cannot fire while moving (run-and-gun broken)');
  if (!rng.jogWhileFiring) fail('soldier legs not jogging while torso fires (no strafe-fire)');
  if (!rollInfo.hasRollAction) fail('roll animation action missing (clip did not load/split)');
  if (!rollInfo.started) fail('TryStartRoll did not start a roll while grounded');
  if (!firstFrame.invuln) fail('i-frames not active on the first roll frame');
  if (!midRoll.invuln) fail('roll did not grant i-frames mid-roll');
  if (postRoll.stillRolling) fail('roll never ended (possible lock)');
  if (errors.length) { ok = false; log('\n=== RUNTIME ERRORS (' + errors.length + ') ==='); errors.slice(0, 40).forEach((e) => log(e)); }

  log('\n' + (ok ? '✅ SMOKE TEST PASSED' : '❌ SMOKE TEST FAILED'));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  if (errors.length) { log('--- collected page errors ---'); errors.forEach((x) => log(x)); }
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
