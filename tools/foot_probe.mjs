// Headless verification for the procedural foot/terrain IK + clipless crouch (FootIK + PlayerBody).
// Boots the real game in Chrome for Testing, drives Step(dt) deterministically, and asserts:
//   * leg geometry resolves + FootIK calibrates its ankle rest height;
//   * FLAT ground is a near no-op (no terrain hip drop, feet stay planted, finite);
//   * CROUCH emerges with no clip: the head drops ~crouchModelDrop, the feet stay planted (don't sink),
//     and the knees bend more;
//   * the layer fades OUT when disabled (airborne/rolling proxy) — gating works;
//   * no NaN in any leg bone across states.
// Exits non-zero (and prints why) on any failure or runtime error.
//
//   node tools/foot_probe.mjs
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
const PORT = 8081;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/foot-chrome', '--window-size=900,600'],
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
    const body = () => window._APP.entityManager.Get('Player').GetComponent('PlayerBody');
    const bones = () => {
      const b = {}; body().model.traverse(o => { if (o.isBone) b[o.name] = o; }); return b;
    };
    const wpos = (o) => { const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
    const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
    const len = (a) => Math.hypot(a[0], a[1], a[2]);
    const norm = (a) => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
    const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    window.__legGeom = () => {
      const B = bones();
      const out = {};
      for (const s of ['l', 'r']) {
        const T = wpos(B['thigh_' + s]), C = wpos(B['calf_' + s]), F = wpos(B['foot_' + s]);
        const upper = len(sub(C, T)), lower = len(sub(F, C));
        const tc = norm(sub(C, T)), cf = norm(sub(F, C));
        const knee = Math.acos(Math.max(-1, Math.min(1, dot(tc, cf)))) * 180 / Math.PI;  // 0 = straight
        out[s] = { footY: +F[1].toFixed(4), upper: +upper.toFixed(3), lower: +lower.toFixed(3), knee: +knee.toFixed(1) };
      }
      return out;
    };
    window.__headY = () => { const B = bones(); return +wpos(B['head'])[1].toFixed(4); };
    window.__footState = () => {
      const fik = body().footIK;
      return { weight: +fik._weight.toFixed(3), hipDrop: +fik._hipDrop.toFixed(4), calibrated: fik._calibrated,
               ankleRest: fik.legs ? fik.legs.map(l => +l.ankleRest.toFixed(3)) : null,
               crouchEased: +body()._crouchEased.toFixed(3) };
    };
    window.__footFinite = () => {
      const fik = body().footIK; if (!fik.legs) return false;
      for (const lg of fik.legs) {
        for (const bn of [lg.thigh, lg.calf, lg.foot]) {
          const q = bn.quaternion; if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) return false;
          const p = bn.position;   if (![p.x, p.y, p.z].every(Number.isFinite)) return false;
        }
      }
      const mp = body().modelRoot.position; return [mp.x, mp.y, mp.z].every(Number.isFinite);
    };
    window.__setCrouch = (on) => {
      window._APP.entityManager.Get('Player').GetComponent('PlayerControls')._crouchToggle = on;
    };
    window.__crouching = () => window._APP.entityManager.Get('Player').GetComponent('PlayerControls').crouching;
    // Directly ease the layer out with enabled:false (no Step in between), to prove the gating.
    window.__disableFootIK = (n) => {
      const fik = body().footIK;
      for (let i = 0; i < n; i++) fik.Update(1 / 60, { enabled: false, speed: 0, bodyYaw: 0 });
      return +fik._weight.toFixed(3);
    };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);

  await step(180);   // settle on the floor; FootIK calibrates its ankle rest height while idle

  // --- Flat ground, standing idle: FootIK engaged, near no-op (no terrain hip drop), feet planted. ---
  const standGeom = await page.evaluate(() => window.__legGeom());
  const standHead = await page.evaluate(() => window.__headY());
  const standState = await page.evaluate(() => window.__footState());
  const standFinite = await page.evaluate(() => window.__footFinite());
  log('STAND legs:', JSON.stringify(standGeom));
  log('STAND head Y:', standHead, 'footState:', JSON.stringify(standState), 'finite:', standFinite);

  // --- Crouch: toggle on, let it ease in. ---
  await page.evaluate(() => window.__setCrouch(true));
  await step(45);
  const crouchGeom = await page.evaluate(() => window.__legGeom());
  const crouchHead = await page.evaluate(() => window.__headY());
  const crouchState = await page.evaluate(() => window.__footState());
  const crouchFinite = await page.evaluate(() => window.__footFinite());
  const crouching = await page.evaluate(() => window.__crouching());
  log('CROUCH legs:', JSON.stringify(crouchGeom));
  log('CROUCH head Y:', crouchHead, 'footState:', JSON.stringify(crouchState), 'crouching:', crouching, 'finite:', crouchFinite);

  // --- Stand back up. ---
  await page.evaluate(() => window.__setCrouch(false));
  await step(45);
  const standedHead = await page.evaluate(() => window.__headY());
  log('STAND-AGAIN head Y:', standedHead);

  // --- Gating: ease the layer out with enabled:false. ---
  const disabledWeight = await page.evaluate(() => window.__disableFootIK(40));
  log('footIK weight after 40 disabled updates:', disabledWeight);

  // ---- verdicts ----
  let ok = true;
  const fail = (m) => { ok = false; log('ASSERT FAIL:', m); };

  if (!standState.calibrated) fail('FootIK never calibrated its ankle rest height');
  if (standState.weight < 0.8) fail(`FootIK not engaged at idle (weight ${standState.weight} < 0.8)`);
  if (!standFinite) fail('STAND: non-finite leg/model transform');
  if (standState.hipDrop > 0.03) fail(`flat ground produced a terrain hip drop (${standState.hipDrop} m > 0.03) — should be ~no-op`);

  const headDrop = standHead - crouchHead;
  if (!crouchFinite) fail('CROUCH: non-finite leg/model transform');
  if (!crouching) fail('crouch flag never engaged');
  if (crouchState.crouchEased < 0.8) fail(`crouch never eased in (_crouchEased ${crouchState.crouchEased})`);
  if (headDrop < 0.22) fail(`head did not drop enough when crouching (${headDrop.toFixed(3)} m < 0.22) — crouch not lowering the body`);
  if (headDrop > 0.55) fail(`head dropped too far when crouching (${headDrop.toFixed(3)} m > 0.55)`);
  // Feet must stay planted (NOT sink with the lowered body) — the core proof the leg IK is working.
  for (const s of ['l', 'r']) {
    const sink = standGeom[s].footY - crouchGeom[s].footY;
    if (Math.abs(sink) > 0.08) fail(`${s} foot moved ${sink.toFixed(3)} m when crouching (>0.08) — not planted to ground`);
    if (crouchGeom[s].knee < standGeom[s].knee + 8) fail(`${s} knee did not bend more when crouching (stand ${standGeom[s].knee}° -> crouch ${crouchGeom[s].knee}°)`);
  }
  if (Math.abs(standedHead - standHead) > 0.08) fail(`did not return to standing head height (${standHead} -> ${standedHead})`);
  if (disabledWeight > 0.05) fail(`FootIK did not fade out when disabled (weight ${disabledWeight} > 0.05) — gating broken`);

  if (errors.length) { ok = false; log('\n=== RUNTIME ERRORS (' + errors.length + ') ==='); errors.slice(0, 40).forEach((e) => log(e)); }

  log('\n' + (ok ? '✅ FOOT IK / CROUCH TEST PASSED' : '❌ FOOT IK / CROUCH TEST FAILED'));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  log('HARNESS ERROR:', e.stack || e.message);
  if (errors.length) { log('--- collected page errors ---'); errors.forEach((x) => log(x)); }
  process.exitCode = 2;
} finally {
  await browser.close();
  server.close();
}
