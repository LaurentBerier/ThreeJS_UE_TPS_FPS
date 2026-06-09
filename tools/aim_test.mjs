// Headless verification for the weapon aim-alignment + two-hand IK (WeaponAimIK).
// Boots the real game in Chrome for Testing, drives Step(dt) deterministically, and asserts the
// CORE claims of the feature:
//   * while aiming, the BARREL points at the crosshair's world target (angle(barrel, muzzle->target)
//     is ~0) — at pitch up / level / down, and in BOTH TPS and FPS;
//   * the SUPPORT hand reaches the foregrip socket (two-hand attachment), no NaN in the arm;
//   * when NOT aiming/shooting the correction blends fully OUT (alpha ~ 0) so locomotion is untouched;
//   * a weapon switch WHILE aiming doesn't throw and stays aligned.
// Exits non-zero (and prints why) on any failure or runtime error.
//
//   node tools/aim_test.mjs
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
const PORT = 8079;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/aim-chrome', '--window-size=900,600'],
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
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    // In-page helpers (THREE isn't global here, so read matrices/vectors by hand).
    window.__angleBarrelToTarget = () => {
      const ik = window._APP.entityManager.Get('Player').GetComponent('PlayerBody').weaponAimIK;
      const a = ik._debug.barrelFwd, b = ik._debug.correctedDir;
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    };
    window.__handGripDist = () => {
      const body = window._APP.entityManager.Get('Player').GetComponent('PlayerBody');
      const ik = body.weaponAimIK;
      const hand = ik.bones.hand_l; if (!hand) return null;
      const e = hand.matrixWorld.elements;
      const hx = e[12], hy = e[13], hz = e[14];
      const g = ik._debug.leftGrip;
      return Math.hypot(hx - g.x, hy - g.y, hz - g.z);
    };
    window.__armFinite = () => {
      const ik = window._APP.entityManager.Get('Player').GetComponent('PlayerBody').weaponAimIK;
      const bs = [ik.bones.upperarm_l, ik.bones.lowerarm_l, ik.bones.hand_l, ik.weaponPivot];
      for (const b of bs) { if (!b) continue; const q = b.quaternion; if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) return false; }
      return true;
    };
    window.__setAim = (on) => {
      const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
      pc.aiming = on;
    };
    window.__setPitch = (x) => {
      const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
      pc.angles.x = x; pc.UpdateRotation();
    };
    window.__handLY = () => {
      const ik = window._APP.entityManager.Get('Player').GetComponent('PlayerBody').weaponAimIK;
      const h = ik.bones.hand_l; return h ? h.matrixWorld.elements[13] : null;
    };
    window.__setTwoHanded = (v) => {
      window._APP.entityManager.Get('Player').GetComponent('PlayerBody').weaponAimIK.twoHanded = v;
    };
    window.__aimState = () => {
      const player = window._APP.entityManager.Get('Player');
      const pc = player.GetComponent('PlayerControls');
      const ik = player.GetComponent('PlayerBody').weaponAimIK;
      return { aimAlpha: +ik._aimAlpha.toFixed(3), gripAlpha: +ik._gripAlpha.toFixed(3),
               valid: pc.aimTargetValid, mode: pc.cameraMode,
               barrelResolved: ik._barrelResolved, socketsCaptured: ik._socketsCaptured };
    };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);

  await step(150);   // settle on the floor; the IK resolves its barrel/sockets on its first updates

  // --- ALWAYS-ON GRIP (the anti-snap core): the player has NOT aimed yet. The support hand must
  // already be glued to the foregrip (grip blend high, aim blend ~0) and the sockets captured from the
  // idle pose. Pre-split this would read the raw clip hand position (far off the foregrip). ---
  const idleState = await page.evaluate(() => window.__aimState());
  const idleHandDist = await page.evaluate(() => window.__handGripDist());
  const idleFinite = await page.evaluate(() => window.__armFinite());
  log('IDLE (never aimed) state:', JSON.stringify(idleState), 'hand→grip:', idleHandDist == null ? null : +idleHandDist.toFixed(3));

  // --- TPS aiming at three pitches: barrel must converge on the crosshair target every time. ---
  const tpsAngles = {};
  for (const [name, pitch] of [['up', 0.45], ['level', 0.0], ['down', -0.45]]) {
    await page.evaluate(() => window.__setAim(true));
    await page.evaluate((x) => window.__setPitch(x), pitch);
    await step(45);   // ease alpha -> 1 and converge the barrel/IK
    const angle = await page.evaluate(() => window.__angleBarrelToTarget());
    const handDist = await page.evaluate(() => window.__handGripDist());
    const finite = await page.evaluate(() => window.__armFinite());
    tpsAngles[name] = { angle: +angle.toFixed(2), handDist: handDist == null ? null : +handDist.toFixed(3), finite };
  }
  log('TPS aim (barrel→target angle°, hand→grip m):', JSON.stringify(tpsAngles));
  const stateAiming = await page.evaluate(() => window.__aimState());
  log('TPS aiming state:', JSON.stringify(stateAiming));

  // --- Release aim: the BARREL correction must blend out, but the GRIP must STAY on (hands stay glued
  // to the gun — no release/re-grab snap). Hand must still be on the foregrip after release. ---
  await page.evaluate(() => { window.__setAim(false); window.__setPitch(0); });
  await step(60);
  const released = await page.evaluate(() => window.__aimState());
  const releasedHandDist = await page.evaluate(() => window.__handGripDist());
  log('after release:', JSON.stringify(released), 'hand→grip:', releasedHandDist == null ? null : +releasedHandDist.toFixed(3));

  // --- Weapon switch WHILE aiming: must not throw and must re-align. ---
  await page.evaluate(() => window.__setAim(true));
  await step(30);
  await page.evaluate(() => window._APP.entityManager.Get('Player').GetComponent('WeaponManager').EquipWeapon(1));
  await step(40);
  const afterSwap = { angle: +(await page.evaluate(() => window.__angleBarrelToTarget())).toFixed(2),
                      finite: await page.evaluate(() => window.__armFinite()) };
  log('after weapon swap while aiming:', JSON.stringify(afterSwap));

  // --- FPS aiming: same accuracy claim. ---
  await page.evaluate(() => {
    window.__setAim(false);
    window._APP.entityManager.Get('Player').GetComponent('PlayerControls').ToggleCamera(); // -> FPS
  });
  await step(20);
  await page.evaluate(() => { window.__setAim(true); window.__setPitch(0.2); });
  await step(45);
  const fps = { mode: (await page.evaluate(() => window.__aimState())).mode,
                angle: +(await page.evaluate(() => window.__angleBarrelToTarget())).toFixed(2),
                finite: await page.evaluate(() => window.__armFinite()) };
  log('FPS aim:', JSON.stringify(fps));

  // --- One-handed: flip twoHanded off. The foregrip solve is skipped and the off-hand relaxes DOWN,
  // but the barrel still aims (dominant-hand wrist aim is independent of the support arm). ---
  await page.evaluate(() => { window.__setAim(true); window.__setPitch(0); });
  await step(20);
  const handLTwo = await page.evaluate(() => window.__handLY());
  await page.evaluate(() => window.__setTwoHanded(false));
  await step(40);
  const oneH = {
    handLOne: await page.evaluate(() => window.__handLY()),
    angle: +(await page.evaluate(() => window.__angleBarrelToTarget())).toFixed(2),
    finite: await page.evaluate(() => window.__armFinite()),
  };
  await page.evaluate(() => window.__setTwoHanded(true));   // restore for any later checks
  log('one-handed:', JSON.stringify(oneH), 'handL two-handed Y:', handLTwo == null ? null : +handLTwo.toFixed(3));

  // ---- verdicts ----
  let ok = true;
  const fail = (m) => { ok = false; log('ASSERT FAIL:', m); };
  // Anti-snap (always-on grip) — measured BEFORE the player ever aimed.
  if (!idleState.socketsCaptured) fail('grip sockets never captured at idle (capture must not require aiming)');
  if (idleState.gripAlpha < 0.9) fail(`grip blend not engaged at idle (gripAlpha ${idleState.gripAlpha} < 0.9) — support hand not glued`);
  if (idleState.aimAlpha > 0.1) fail(`aim blend active while NOT aiming (aimAlpha ${idleState.aimAlpha})`);
  if (!idleFinite) fail('IDLE: non-finite arm/weapon quaternion');
  if (idleHandDist != null && idleHandDist > 0.06) fail(`IDLE: support hand off the foregrip (${idleHandDist.toFixed(3)} m > 0.06) — grip not always-on`);

  if (!stateAiming.barrelResolved) fail('barrel never resolved');
  if (!stateAiming.socketsCaptured) fail('grip sockets never captured');
  if (stateAiming.aimAlpha < 0.9) fail('aim blend never reached full (aimAlpha < 0.9 while aiming)');
  for (const k of ['up', 'level', 'down']) {
    if (!tpsAngles[k].finite) fail(`TPS ${k}: non-finite arm/weapon quaternion`);
    if (tpsAngles[k].angle > 3.0) fail(`TPS ${k}: barrel not on target (${tpsAngles[k].angle}° > 3°)`);
    if (tpsAngles[k].handDist != null && tpsAngles[k].handDist > 0.035) fail(`TPS ${k}: support hand off the foregrip (${tpsAngles[k].handDist} m > 0.035)`);
  }
  if (released.aimAlpha > 0.1) fail(`barrel correction did not blend out on release (aimAlpha ${released.aimAlpha})`);
  if (released.gripAlpha < 0.9) fail(`grip released on aim-out (gripAlpha ${released.gripAlpha} < 0.9) — hands should stay on the gun`);
  if (releasedHandDist != null && releasedHandDist > 0.06) fail(`after release: support hand left the foregrip (${releasedHandDist.toFixed(3)} m > 0.06) — the snap`);
  if (!afterSwap.finite) fail('weapon swap while aiming produced non-finite pose');
  if (afterSwap.angle > 3.5) fail(`barrel off target after weapon swap (${afterSwap.angle}°)`);
  if (fps.mode !== 'FPS') fail('did not switch to FPS');
  if (!fps.finite) fail('FPS: non-finite arm/weapon quaternion');
  if (fps.angle > 4.0) fail(`FPS barrel not on target (${fps.angle}° > 4°)`);
  // One-handed.
  if (!oneH.finite) fail('one-handed: non-finite arm/weapon quaternion');
  if (oneH.angle > 4.5) fail(`one-handed barrel off target (${oneH.angle}° > 4.5°)`);
  if (handLTwo != null && oneH.handLOne != null && oneH.handLOne > handLTwo - 0.02)
    fail(`one-handed off-hand did not relax downward (two-handed Y ${handLTwo.toFixed(3)} -> one-handed Y ${oneH.handLOne.toFixed(3)})`);
  if (errors.length) { ok = false; log('\n=== RUNTIME ERRORS (' + errors.length + ') ==='); errors.slice(0, 40).forEach((e) => log(e)); }

  log('\n' + (ok ? '✅ AIM IK TEST PASSED' : '❌ AIM IK TEST FAILED'));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  if (errors.length) { log('--- collected page errors ---'); errors.forEach((x) => log(x)); }
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
