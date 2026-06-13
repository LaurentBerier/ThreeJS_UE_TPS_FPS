// Diagnostic: TPS crouch + crouch-jump stability. Boots the real game headless, steps Step(dt)
// deterministically, drives the REAL input path (KeyboardEvent on document, like a player), and
// traces per-frame: capsule origin Y, vertical velocity, crouched (physics) / crouching (controls),
// canJump, airState, _crouchEased, modelRoot Y, tracked eye Y (Player.Position), camera Y.
// Scenarios: standing jump (baseline), crouch enter/exit, crouch-idle jump (C toggle), crouch-idle
// jump (Alt held), crouch-WALK jump. Flags anomalies: eaten jump (vy collapses while rising),
// capsule re-crouch thrash after a jump, per-frame camera/eye pops, landing state != standing.
//   node tools/diag_crouchjump.mjs
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
const PORT = 8093;
await new Promise((r) => server.listen(PORT, r));

const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/crouchjump-chrome', '--window-size=900,600'],
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
    // One sampled frame: step once, then read everything.
    window.__sample = () => {
      const pc = window.__pc(), ph = window.__ph(), bd = window.__body();
      const o = ph.body.getWorldTransform().getOrigin();
      const v = ph.body.getLinearVelocity();
      return {
        py: +o.y().toFixed(4), vy: +v.y().toFixed(3),
        crP: ph.crouched ? 1 : 0, crC: pc.crouching ? 1 : 0,
        cj: ph.canJump ? 1 : 0, air: bd.airState || '-',
        ce: +bd._crouchEased.toFixed(3),
        rootY: +bd.modelRoot.position.y.toFixed(4),
        eyeY: +P().Position.y.toFixed(4),
        camY: +window._APP.camera.position.y.toFixed(4),
        loco: bd.lowerState || '-',
      };
    };
    window.__trace = (frames) => {
      const out = [];
      for (let i = 0; i < frames; i++) {
        const sb = window.__swaps.length;
        window.__step(1);
        const s = window.__sample();
        s.sw = window.__swaps.slice(sb).map(e => (e.to ? 1 : 0));   // capsule swaps THIS frame (1=to crouch)
        out.push(s);
      }
      return out;
    };
    // Single-frame Space TAP, traced. A held Space masks the eaten-jump bug: if a same-frame
    // re-crouch zeroes the jump velocity, the still-held key immediately re-stands + re-jumps and
    // the trace shows a clean arc. A real player taps — so tap for tapLen frames and trace from
    // the take-off frame itself.
    window.__traceJump = (frames, tapLen = 1) => {
      const out = [];
      window.__press('Space');
      for (let i = 0; i < frames; i++) {
        const sb = window.__swaps.length;
        window.__step(1);
        if (i === tapLen - 1) window.__release('Space');
        const s = window.__sample();
        s.sw = window.__swaps.slice(sb).map(e => (e.to ? 1 : 0));
        out.push(s);
      }
      return out;
    };
    // Instrument SetCrouched to count shape swaps (capsule thrash detector).
    const ph = window.__ph();
    window.__swaps = [];
    const orig = ph.SetCrouched.bind(ph);
    let frame = 0;
    window.__tick = () => frame++;
    ph.SetCrouched = (want) => {
      const before = ph.crouched;
      const r = orig(want);
      if (ph.crouched !== before) window.__swaps.push({ frame, to: ph.crouched });
      return r;
    };
    const stepOrig = window.__step;
    window.__step = (n, dt) => { for (let i = 0; i < n; i++) { frame++; stepOrig(1, dt); } };
  });

  const trace = (n) => page.evaluate((n) => window.__trace(n), n);
  const traceJump = (n, tap = 1) => page.evaluate((n, tap) => window.__traceJump(n, tap), n, tap);
  const press = (c) => page.evaluate((c) => window.__press(c), c);
  const release = (c) => page.evaluate((c) => window.__release(c), c);
  const step = (n) => page.evaluate((n) => window.__step(n), n);
  const swaps = () => page.evaluate(() => { const s = window.__swaps.slice(); window.__swaps.length = 0; return s; });

  const fmt = (s, i) =>
    `${String(i).padStart(3)}  py=${s.py.toFixed(3)} vy=${String(s.vy).padStart(7)} crP=${s.crP} crC=${s.crC} cj=${s.cj} ` +
    `air=${String(s.air).padStart(5)} ce=${s.ce.toFixed(2)} rootY=${s.rootY.toFixed(3)} eyeY=${s.eyeY.toFixed(3)} camY=${s.camY.toFixed(3)} ${s.loco}`;

  const analyze = (name, tr, { expectLandStanding = true } = {}) => {
    log(`\n=== ${name} ===`);
    // jump start = first frame vy > 2
    const j = tr.findIndex(s => s.vy > 2);
    const anomalies = [];
    // 1) eaten jump: vy collapses to <=0.5 within 8 frames of take-off while still low
    if (j >= 0) {
      for (let i = j + 1; i < Math.min(j + 8, tr.length); i++) {
        if (tr[i].vy < 0.5 && tr[i].py < tr[j].py + 0.5) { anomalies.push(`vy collapsed at f${i} (${tr[i].vy}) — jump eaten`); break; }
      }
    } else if (name.includes('jump')) anomalies.push('no take-off detected (vy never > 2)');
    // 2) capsule crouch-state flips after take-off
    if (j >= 0) {
      let flips = 0;
      for (let i = j + 1; i < tr.length; i++) if (tr[i].crP !== tr[i - 1].crP) flips++;
      if (flips > (expectLandStanding ? 0 : 1)) anomalies.push(`capsule crouch state flipped ${flips}x after take-off`);
    }
    // 2b) swap THRASH: ≥2 capsule shape swaps inside one frame (stand→crouch→stand) — each swap
    //     teleports the origin ±centerDrop and zeroes the vertical velocity. Always a bug.
    for (let i = 0; i < tr.length; i++) {
      if ((tr[i].sw || []).length >= 2) anomalies.push(`capsule swap THRASH at f${i} (${tr[i].sw.join(',')})`);
    }
    // 2c) mid-air re-crouch: a swap TO crouched on a frame the body is rising (jump being eaten)
    if (j >= 0) {
      for (let i = j; i < tr.length; i++) {
        if ((tr[i].sw || []).includes(1) && tr[i].vy > 0.5) anomalies.push(`re-crouched while RISING at f${i} (vy=${tr[i].vy})`);
      }
    }
    // 3) per-frame camera pops (TPS cam should be smooth; > 0.25 m/frame at 60 fps is a visible snap
    //    outside the jump arc; during the arc the cam legitimately follows ~vy/60 <= 0.09)
    for (let i = 1; i < tr.length; i++) {
      const d = Math.abs(tr[i].camY - tr[i - 1].camY);
      const cap = Math.abs(tr[i].py - tr[i - 1].py) + 0.06;
      if (d > Math.max(0.12, cap * 1.5)) anomalies.push(`camY pop ${d.toFixed(3)} m at f${i}`);
    }
    for (let i = 1; i < tr.length; i++) {
      const d = Math.abs(tr[i].eyeY - tr[i - 1].eyeY);
      const cap = Math.abs(tr[i].py - tr[i - 1].py) + 0.06;
      if (d > Math.max(0.12, cap * 1.5)) anomalies.push(`eyeY pop ${d.toFixed(3)} m at f${i}`);
    }
    // 4) landing state
    const last = tr[tr.length - 1];
    if (expectLandStanding && (last.crP || last.crC)) anomalies.push(`landed CROUCHED (crP=${last.crP} crC=${last.crC})`);
    // print frames around take-off + landing
    if (j >= 0) {
      const landRel = tr.slice(j).findIndex(s => s.cj === 1 && s.vy <= 0.01);
      const land = landRel >= 0 ? j + landRel : tr.length - 1;
      log(' take-off window:');
      for (let i = Math.max(0, j - 3); i < Math.min(tr.length, j + 10); i++) log(fmt(tr[i], i));
      log(' landing window:');
      for (let i = Math.max(0, land - 4); i < Math.min(tr.length, land + 8); i++) log(fmt(tr[i], i));
    } else {
      for (let i = 0; i < Math.min(tr.length, 16); i++) log(fmt(tr[i], i));
    }
    if (anomalies.length) { log(' ANOMALIES:'); anomalies.forEach(a => log('  ✗ ' + a)); }
    else log(' ✓ no anomalies');
    return anomalies;
  };

  await step(240);  // settle + FootIK calibration
  const all = {};

  // --- baseline standing jump (single-frame tap) ---
  all['standing jump'] = analyze('standing jump (baseline, 1-frame tap)', await traceJump(110));
  log(' capsule swaps:', JSON.stringify(await swaps()));
  await step(90);

  // --- crouch enter/exit (C toggle) ---
  await press('KeyC'); await step(2); await release('KeyC');
  const enter = await trace(90);
  log('\n=== crouch enter (C) ===');
  [0, 1, 2, 5, 10, 20, 40, 60, 89].forEach(i => log(fmt(enter[i], i)));
  const crouchedNow = enter[89].crP === 1 && enter[89].crC === 1;
  log(crouchedNow ? ' ✓ crouched engaged' : ' ✗ CROUCH DID NOT ENGAGE');
  log(' capsule swaps:', JSON.stringify(await swaps()));

  // --- crouch-idle jump (C toggle, single-frame tap) ---
  all['crouch jump (toggle)'] = analyze('crouch-idle jump (C toggle, 1-frame tap)', await traceJump(110));
  log(' capsule swaps:', JSON.stringify(await swaps()));
  await step(90);

  // --- crouch-idle jump (Alt held the whole time, single-frame tap) ---
  await press('AltLeft'); await step(40);
  // Alt stays held: landing back into crouch is the expected design here
  all['crouch jump (alt held)'] = analyze('crouch-idle jump (Alt HELD, 1-frame tap)', await traceJump(110), { expectLandStanding: false });
  log(' capsule swaps:', JSON.stringify(await swaps()));
  await release('AltLeft'); await step(60);

  // --- crouch-WALK jump (C toggle + W held, single-frame tap) ---
  await press('KeyC'); await step(2); await release('KeyC'); await step(40);
  await press('KeyW'); await step(40);
  all['crouch-walk jump'] = analyze('crouch-WALK jump (W held, 1-frame tap)', await traceJump(110));
  log(' capsule swaps:', JSON.stringify(await swaps()));
  await release('KeyW'); await step(30);

  // --- rapid crouch spam + jump (stress) ---
  for (let i = 0; i < 4; i++) { await press('KeyC'); await step(3); await release('KeyC'); await step(3); }
  all['spam + jump'] = analyze('crouch spam then jump (1-frame tap)', await traceJump(110), { expectLandStanding: false });
  log(' capsule swaps:', JSON.stringify(await swaps()));

  const totalAnoms = Object.values(all).flat().length;
  log(`\n==== SUMMARY: ${totalAnoms} anomalies ====`);
  for (const [k, v] of Object.entries(all)) log(`  ${v.length ? '✗' : '✓'} ${k}${v.length ? ': ' + v.join(' | ') : ''}`);
  if (errors.length) { log('\nRUNTIME ERRORS:'); errors.forEach(e => log(' ', e)); }
  process.exit(totalAnoms || errors.length ? 1 : 0);
} catch (e) {
  console.error('FATAL', e);
  if (errors.length) errors.forEach(x => console.error(x));
  process.exit(2);
} finally {
  await browser.close();
  server.close();
}
