// Diagnostic: measure FOOT SKATE across locomotion states (standing-walk / crouch-walk / aim-walk).
// Deterministic fixed-dt stepping. A foot-synced gait plants the stance foot, so its WORLD horizontal
// speed drops to ~0 while the body moves past it; a skating foot keeps sliding (its world speed never
// settles). Metric per state: the avg of the slower foot's world horizontal speed over a window,
// normalised by body speed — ~0.2-0.4 = good plant, ~0.7+ = heavy skate. Also reports the foot-sync
// timeScale and calf-bone jerk (knee pop) for context.
//   CHROME_BIN="...msedge.exe" node tools/crouch_probe.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.fbx': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.obj': 'text/plain', '.wav': 'audio/wav', '.tga': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' }); res.end(readFileSync(fpath));
});
const PORT = 8092;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=900,600'],
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
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    const P = () => window._APP.entityManager.Get('Player');
    window.__pc = () => P().GetComponent('PlayerControls');
    window.__body = () => P().GetComponent('PlayerBody');
    window.__V3 = () => window.__body().modelRoot.position.constructor;
    window.__Q = () => window.__body().model.quaternion.constructor;
    window.__press = (code) => document.dispatchEvent(new KeyboardEvent('keydown', { code }));
    window.__release = (code) => document.dispatchEvent(new KeyboardEvent('keyup', { code }));
    window.__bones = () => { const o = {}; window.__body().model.traverse(b => { if (b.isBone && ['foot_l','foot_r','calf_l','calf_r'].includes(b.name)) o[b.name] = b; }); return o; };
    // Per-state foot-skate sampler. dt fixed at 1/60, so foot world displacement / dt = world speed.
    window.__skate = (frames) => {
      const V3 = window.__V3(), Q = window.__Q(); const b = window.__bones(); const dt = 1/60;
      const fl = b.foot_l, fr = b.foot_r, cl = b.calf_l, cr = b.calf_r;
      let pL = fl.getWorldPosition(new V3()), pR = fr.getWorldPosition(new V3());
      let pBody = P().Position.clone();
      let qL = cl.getWorldQuaternion(new Q()), qR = cr.getWorldQuaternion(new Q());
      let sumMin = 0, n = 0, bodySum = 0, maxCalf = 0, ts = 0;
      for (let i = 0; i < frames; i++) {
        window.__step(1);
        const nL = fl.getWorldPosition(new V3()), nR = fr.getWorldPosition(new V3());
        const nBody = P().Position.clone();
        const hsL = Math.hypot(nL.x - pL.x, nL.z - pL.z) / dt;
        const hsR = Math.hypot(nR.x - pR.x, nR.z - pR.z) / dt;
        const bodyH = Math.hypot(nBody.x - pBody.x, nBody.z - pBody.z) / dt;
        sumMin += Math.min(hsL, hsR); bodySum += bodyH; n++;
        const nq = cl.getWorldQuaternion(new Q()), nqr = cr.getWorldQuaternion(new Q());
        maxCalf = Math.max(maxCalf, qL.angleTo(nq) * 180 / Math.PI, qR.angleTo(nqr) * 180 / Math.PI);
        pL = nL; pR = nR; pBody = nBody; qL = nq; qR = nqr;
      }
      const body = window.__body();
      ts = body.lowerActions[body.lowerState] ? +body.lowerActions[body.lowerState].getEffectiveTimeScale().toFixed(3) : 0;
      const avgMin = sumMin / n, avgBody = bodySum / n;
      return { state: body.lowerState, timeScale: ts, avgBodySpeed: +avgBody.toFixed(2),
        avgPlantedFootSpeed: +avgMin.toFixed(2), skateRatio: +(avgMin / Math.max(0.01, avgBody)).toFixed(2),
        maxCalfJerk: +maxCalf.toFixed(2) };
    };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);
  await step(220); // settle + FootIK calibrate

  const measure = async (label, setup, teardown) => {
    await page.evaluate(setup);
    await step(50); // reach steady state
    const r = await page.evaluate(() => window.__skate(120));
    log(`  ${label.padEnd(14)} state=${r.state}  ts=${r.timeScale}  body=${r.avgBodySpeed} m/s  plantedFoot=${r.avgPlantedFootSpeed} m/s  SKATE=${r.skateRatio}  calfJerk=${r.maxCalfJerk}°/f`);
    await page.evaluate(teardown); await step(40);
    return r;
  };

  log('\nFOOT SKATE by state (skateRatio: ~0.2-0.4 good plant, 0.7+ heavy skate):');
  await measure('stand-walk', () => { window.__press('KeyW'); }, () => { window.__release('KeyW'); });
  await measure('crouch-walk', () => { window.__pc()._crouchToggle = true; window.__press('KeyW'); },
                () => { window.__release('KeyW'); window.__pc()._crouchToggle = false; });
  await measure('aim-walk', () => { const pc = window.__pc(); pc.aiming = true; pc._aimHeld = true; window.__press('KeyW'); },
                () => { const pc = window.__pc(); pc.aiming = false; pc._aimHeld = false; window.__release('KeyW'); });

  if (errors.length) { log('\nERRORS:', errors.slice(0, 10).join('\n')); } else { log('\n✅ no runtime errors'); }
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); server.close(); }
