// Read-only rig geometry probe. Boots the real game headless (Chrome for Testing, same
// harness as smoke_test.mjs), forces a known aim state, then dumps the WORLD transforms of
// the bones/objects the weapon-aim + two-hand-IK feature needs as ground truth:
//   * the in-hand weapon pivot's world basis + the empirical barrel-forward axis
//     (muzzleAnchor - hand_r), so we know MuzzleForwardAxis in the pivot's local frame
//   * where hand_l naturally sits in the gun's local frame (a starting foregrip socket)
//   * arm bone world positions + segment lengths for two-bone IK (both arms)
//   * spine chain + camera, for sanity
// Everything is read out as plain matrixWorld.elements arrays and reduced in node — no THREE
// import needed in-page. Pure diagnostics; writes nothing to the game.
//
//   node tools/rig_probe.mjs
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
    '--user-data-dir=/tmp/probe-chrome', '--window-size=900,600'],
});

// ---- tiny column-major mat4 helpers (matrixWorld.elements are column-major) ----
const pos = (e) => [e[12], e[13], e[14]];
const axisX = (e) => norm([e[0], e[1], e[2]]);
const axisY = (e) => norm([e[4], e[5], e[6]]);
const axisZ = (e) => norm([e[8], e[9], e[10]]);
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const r3 = (a) => a.map((v) => +v.toFixed(3));
const deg = (c) => +(Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI).toFixed(1);
// invert a column-major rigid-ish 4x4 and apply to a point (handles scale via full inverse)
function invMul(e, p) {
  // general 4x4 inverse (column-major) — adequate for our scaled bone matrices
  const m = e;
  const inv = new Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  det = det ? 1/det : 0;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  const x = p[0], y = p[1], z = p[2];
  return [
    inv[0]*x + inv[4]*y + inv[8]*z + inv[12],
    inv[1]*x + inv[5]*y + inv[9]*z + inv[13],
    inv[2]*x + inv[6]*y + inv[10]*z + inv[14],
  ];
}
// which local pivot axis (+/-x,y,z) best matches a world direction
function classifyAxis(e, worldDir) {
  const axes = { '+x': axisX(e), '+y': axisY(e), '+z': axisZ(e) };
  let best = null, bestDot = -2;
  for (const k of ['x', 'y', 'z']) {
    const a = { x: axisX(e), y: axisY(e), z: axisZ(e) }[k];
    const d = dot(a, worldDir);
    if (Math.abs(d) > Math.abs(bestDot)) { bestDot = d; best = (d < 0 ? '-' : '+') + k; }
  }
  return { axis: best, alignment: +bestDot.toFixed(3) };
}

const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));

  log('loading game…');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);

  await step(150); // settle on the floor

  // Force a known aim state: TPS, look ~level forward, holding aim, fire-hold active so the
  // existing aim pose is engaged exactly as it would be in combat.
  await page.evaluate(() => {
    const em = window._APP.entityManager;
    const pc = em.Get('Player').GetComponent('PlayerControls');
    const body = em.Get('Player').GetComponent('PlayerBody');
    pc.cameraMode = 'TPS';
    pc.angles.x = 0.0; pc.angles.y = 0.0; pc.UpdateRotation();
    pc.aiming = true;
    body._shootHold = 0.25;
  });
  await step(60); // let the aim pose + camera ease in

  const data = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const body = player.GetComponent('PlayerBody');
    const wm = player.GetComponent('WeaponManager');
    const pc = player.GetComponent('PlayerControls');
    body.model.updateMatrixWorld(true);
    if (wm.muzzleAnchor) wm.muzzleAnchor.updateMatrixWorld(true);

    const bones = {};
    body.model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    const E = (o) => (o && o.matrixWorld ? Array.from(o.matrixWorld.elements) : null);

    const out = {
      camera: E(pc.camera),
      weaponPivot: E(body.weaponPivot),
      muzzleAnchor: wm.muzzleAnchor ? E(wm.muzzleAnchor) : null,
      bones: {},
      weaponLocalBox: null,
      aiming: pc.aiming, mode: pc.cameraMode,
      aimPitchWeight: +(body._aimPitchWeight || 0).toFixed(3),
    };
    const want = ['root','pelvis','spine_01','spine_02','spine_03','neck_01','head',
      'clavicle_r','upperarm_r','lowerarm_r','hand_r',
      'clavicle_l','upperarm_l','lowerarm_l','hand_l',
      'ik_hand_gun','ik_hand_r','ik_hand_l'];
    for (const n of want) out.bones[n] = E(bones[n]);

    // weapon geometry bbox in the pivot's LOCAL frame (min/max), to know the barrel axis/length
    const pivot = body.weaponPivot;
    if (pivot) {
      pivot.updateWorldMatrix(true, true);
      const toLocal = pivot.matrixWorld.clone().invert();
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      const v = new pivot.position.constructor();
      pivot.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        for (let i = 0; i < 8; i++) {
          v.set((i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z);
          v.applyMatrix4(o.matrixWorld).applyMatrix4(toLocal);
          mn = [Math.min(mn[0], v.x), Math.min(mn[1], v.y), Math.min(mn[2], v.z)];
          mx = [Math.max(mx[0], v.x), Math.max(mx[1], v.y), Math.max(mx[2], v.z)];
        }
      });
      out.weaponLocalBox = { min: mn, max: mx };
    }
    return out;
  });

  if (errors.length) { log('PAGE ERRORS:', errors.slice(0, 5)); }

  // ---- reduce ----
  const B = data.bones;
  const handR = pos(B.hand_r), handL = pos(B.hand_l);
  const muzzle = data.muzzleAnchor ? pos(data.muzzleAnchor) : null;
  const camP = pos(data.camera);

  log('\n================ RIG PROBE ================');
  log('state: mode=%s aiming=%s aimPitchWeight=%s', data.mode, data.aiming, data.aimPitchWeight);
  log('camera pos', r3(camP), 'forward(-z)', r3(norm(sub([0,0,0], axisZ(data.camera)))));

  log('\n-- weapon pivot --');
  log('pivot pos', r3(pos(data.weaponPivot)));
  log('pivot local axes(world): +x', r3(axisX(data.weaponPivot)), '+y', r3(axisY(data.weaponPivot)), '+z', r3(axisZ(data.weaponPivot)));
  if (data.weaponLocalBox) {
    const s = sub(data.weaponLocalBox.max, data.weaponLocalBox.min);
    log('weapon local bbox size', r3(s), '(longest axis = barrel)');
  }
  if (muzzle) {
    log('muzzleAnchor pos', r3(muzzle));
    const barrel = norm(sub(muzzle, handR));
    log('barrel dir (muzzle - hand_r)', r3(barrel));
    log('=> barrel matches pivot local axis:', JSON.stringify(classifyAxis(data.weaponPivot, barrel)));
    log('   (this is MuzzleForwardAxis in weapon-pivot LOCAL space, sign included)');
    log('barrel vs camera-forward angle (deg):', deg(dot(barrel, norm(sub([0,0,0], axisZ(data.camera))))));
    log('muzzle distance from camera (m):', +len(sub(muzzle, camP)).toFixed(3));
  }

  log('\n-- foregrip socket (where hand_l currently sits, in weapon-pivot LOCAL frame) --');
  const handLlocal = invMul(data.weaponPivot, handL);
  log('hand_l world', r3(handL), '-> weapon-local', r3(handLlocal));
  log('hand_r world', r3(handR), '-> weapon-local', r3(invMul(data.weaponPivot, handR)));

  log('\n-- arm segment lengths (for two-bone IK) --');
  for (const side of ['r', 'l']) {
    const cl = pos(B['clavicle_' + side]), up = pos(B['upperarm_' + side]), lo = pos(B['lowerarm_' + side]), ha = pos(B['hand_' + side]);
    const upperLen = len(sub(lo, up)), foreLen = len(sub(ha, lo)), reach = len(sub(ha, up));
    log('%s: clav%s upper%s lower%s hand%s | upperLen=%s foreLen=%s reach=%s maxReach=%s',
      side, r3(cl), r3(up), r3(lo), r3(ha),
      upperLen.toFixed(3), foreLen.toFixed(3), reach.toFixed(3), (upperLen + foreLen).toFixed(3));
  }

  log('\n-- spine chain world pos --');
  for (const n of ['pelvis','spine_01','spine_02','spine_03','neck_01','head']) log('%s', n.padEnd(9), r3(pos(B[n])));

  log('\n-- UE virtual IK bones (are they meaningfully placed?) --');
  for (const n of ['ik_hand_gun','ik_hand_r','ik_hand_l']) log('%s', n.padEnd(12), B[n] ? r3(pos(B[n])) : '(absent)');
  log('==========================================\n');
} catch (e) {
  log('PROBE ERROR:', e.stack || e.message);
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
