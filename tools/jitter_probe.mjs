// Diagnostic: measure FPS/TPS camera + head-bone jitter under DETERMINISTIC fixed-dt stepping.
// Because dt is fixed (1/60), any frame-to-frame wobble is a real feedback/oscillation in the pose
// pipeline (not rAF dt variance). Localizes the source by also sampling head-bone Y and modelRoot Y.
//   CHROME_BIN="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" node tools/jitter_probe.mjs
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
const PORT = 8091;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=900,600'],
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
    const P = () => window._APP.entityManager.Get('Player');
    window.__pc = () => P().GetComponent('PlayerControls');
    window.__body = () => P().GetComponent('PlayerBody');
    const headBone = () => { let h = null; window.__body().model.traverse(o => { if (o.isBone && o.name === 'head') h = o; }); return h; };
    window.__sample = () => {
      const cam = window._APP.camera;
      const h = headBone(); const hw = h ? h.getWorldPosition(new window.THREE_V3()) : { x: 0, y: 0, z: 0 };
      const mr = window.__body().modelRoot.position;
      return { cx: cam.position.x, cy: cam.position.y, cz: cam.position.z, hy: hw.y, mry: mr.y };
    };
    // Expose a Vector3 ctor for the sampler (three is module-scoped); grab it off an existing object.
    window.THREE_V3 = window.__body().modelRoot.position.constructor;
    window.__toggleCam = () => window.__pc().ToggleCamera();
    window.__press = (code) => document.dispatchEvent(new KeyboardEvent('keydown', { code }));
    window.__release = (code) => document.dispatchEvent(new KeyboardEvent('keyup', { code }));
    window.__setCrouch = (on) => { window.__pc()._crouchToggle = on; };
    window.__setAim = (on) => { const pc = window.__pc(); pc.aiming = on; pc._aimHeld = on; };
    window.__mode = () => window.__pc().cameraMode;
    window.__muzzleLift = () => { const ik = window.__body().weaponAimIK; return ik ? +(ik._muzzleLift).toFixed(5) : null; };
    // Gun muzzle world position (to detect muzzle-clearance limit-cycle oscillation while aiming).
    window.__muzzle = () => {
      const ik = window.__body().weaponAimIK; if (!ik) return { x: 0, y: 0, z: 0 };
      const p = ik.weaponPivot; p.updateWorldMatrix(true, false);
      const v = ik.muzzleLocal.clone().applyMatrix4(p.matrixWorld);
      return { x: v.x, y: v.y, z: v.z };
    };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);
  const collect = async (frames) => {
    return await page.evaluate((frames) => {
      const arr = [];
      for (let i = 0; i < frames; i++) { window.__step(1); arr.push(window.__sample()); }
      return arr;
    }, frames);
  };
  // Jitter metric: mean & max of per-frame change, after removing the smooth low-freq trend (the head
  // bob). We approximate "jitter" as the second difference magnitude (curvature) — a smooth bob has low
  // curvature; high-frequency wobble spikes it.
  const jitter = (arr, key) => {
    let meanAbs2 = 0, max2 = 0, n = 0;
    for (let i = 2; i < arr.length; i++) {
      const d2 = Math.abs(arr[i][key] - 2 * arr[i - 1][key] + arr[i - 2][key]);
      meanAbs2 += d2; max2 = Math.max(max2, d2); n++;
    }
    const range = Math.max(...arr.map(a => a[key])) - Math.min(...arr.map(a => a[key]));
    return { mean2: +(meanAbs2 / n * 1000).toFixed(3), max2: +(max2 * 1000).toFixed(3), range: +(range * 1000).toFixed(2) };
  };

  await step(180); // settle on floor, FootIK calibrates

  // --- Terrain + grounding sanity ---
  const terrainInfo = await page.evaluate(() => {
    const lvl = window._APP.entityManager.Get('Level');
    const terr = lvl.GetComponent('Terrain');
    let meshInScene = false; window._APP.scene.traverse(o => { if (o.name === 'Terrain') meshInScene = true; });
    const cubeVisible = (() => { let v = null; const lv = window._APP.entityManager.Get('Level').GetComponent('LevelSetup'); lv.mesh.traverse(o => { if (o.name === 'Cube') v = o.visible; }); return v; })();
    const playerPos = window._APP.entityManager.Get('Player').Position;
    const hAtPlayer = terr ? terr.HeightAt(playerPos.x, playerPos.z) : null;
    let soldierY = null, soldierName = null;
    for (const e of window._APP.entityManager.entities) { if (e.name && e.name.startsWith('UeSoldier')) { soldierY = +e.Position.y.toFixed(3); soldierName = e.name; break; } }
    return {
      hasTerrain: !!terr, meshInScene, cubeVisible,
      hRange: terr ? [+Math.min(...terr._heights).toFixed(3), +Math.max(...terr._heights).toFixed(3)] : null,
      playerY: +playerPos.y.toFixed(3), hAtPlayer: hAtPlayer === null ? null : +hAtPlayer.toFixed(3),
      playerFinite: [playerPos.x, playerPos.y, playerPos.z].every(Number.isFinite),
      soldierName, soldierY,
    };
  });
  log('TERRAIN:', JSON.stringify(terrainInfo));

  // --- TPS idle baseline ---
  log('mode:', await page.evaluate(() => window.__mode()));
  let s = await collect(90);
  log('TPS idle     cam.y jitter(µm):', JSON.stringify(jitter(s, 'cy')), ' head.y:', JSON.stringify(jitter(s, 'hy')), ' modelRoot.y:', JSON.stringify(jitter(s, 'mry')));

  // --- FPS idle --- (settle long enough for the hip/spine freeze references to converge, matching the
  // in-game "stand still for ~1s and the view settles" — too short a settle catches the refs mid-converge)
  await page.evaluate(() => window.__toggleCam());
  await step(120);
  log('mode:', await page.evaluate(() => window.__mode()));
  s = await collect(90);
  log('FPS idle     cam.y jitter(µm):', JSON.stringify(jitter(s, 'cy')), ' cam.x:', JSON.stringify(jitter(s, 'cx')), ' head.y:', JSON.stringify(jitter(s, 'hy')), ' modelRoot.y:', JSON.stringify(jitter(s, 'mry')));

  // --- FPS aiming (the reported jitter) ---
  await page.evaluate(() => window.__setAim(true));
  await step(40);
  const sa = await page.evaluate((frames) => {
    const arr = [];
    for (let i = 0; i < frames; i++) { window.__step(1); const s = window.__sample(); s.mz = window.__muzzle().y; s.lift = window.__muzzleLift(); arr.push(s); }
    return arr;
  }, 90);
  log('FPS aiming   cam.y jitter(µm):', JSON.stringify(jitter(sa, 'cy')), ' cam.x:', JSON.stringify(jitter(sa, 'cx')), ' muzzle.y:', JSON.stringify(jitter(sa, 'mz')));
  log('             muzzleLift samples:', sa.slice(0, 8).map(s => s.lift).join(','), '... range', (Math.max(...sa.map(s=>s.lift)) - Math.min(...sa.map(s=>s.lift))).toFixed(5));
  await page.evaluate(() => window.__setAim(false));
  await step(20);

  // --- FPS crouch ---
  await page.evaluate(() => window.__setCrouch(true));
  await step(45);
  s = await collect(90);
  log('FPS crouch   cam.y jitter(µm):', JSON.stringify(jitter(s, 'cy')), ' cam.x:', JSON.stringify(jitter(s, 'cx')), ' head.y:', JSON.stringify(jitter(s, 'hy')), ' modelRoot.y:', JSON.stringify(jitter(s, 'mry')));
  await page.evaluate(() => window.__setCrouch(false));
  await step(45);

  // --- FPS walking (head-bob ridden by the lens) — LAST, since it moves the player onto varied
  // terrain (would otherwise confound the stationary idle/aim/crouch jitter above). cam.x/cy RANGE
  // here includes the world translation of walking; read the mean2/max2 CURVATURE for the bob jitter.
  await page.evaluate(() => window.__press('KeyW'));
  await step(45); // reach jog speed + let the FPS-walk hip/spine damp settle
  s = await collect(90);
  log('FPS walk     cam.y jitter(µm):', JSON.stringify(jitter(s, 'cy')), ' cam.x:', JSON.stringify(jitter(s, 'cx')), ' modelRoot.y:', JSON.stringify(jitter(s, 'mry')));
  await page.evaluate(() => window.__release('KeyW'));
  await step(35);

  if (errors.length) { log('\n=== RUNTIME ERRORS (' + errors.length + ') ==='); errors.slice(0, 40).forEach((e) => log(e)); }
  else { log('\n✅ no runtime errors'); }
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  if (errors.length) { log('--- page errors ---'); errors.forEach((x) => log(x)); }
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
