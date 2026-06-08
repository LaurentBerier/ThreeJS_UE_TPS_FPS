// Deterministic ragdoll-settle probe. Boots the game, seeds a fixed RNG, kills one soldier, then
// steps the sim and logs the corpse's centroid SPEED over time + its peak/lowest joint Y (a crude
// "is it folding into the floor / flailing" read) so I can tell whether the joint limits + bounce
// settle to rest (speed decays toward 0, sleeps) or sit in a limit cycle (speed stays high forever).
// Fixed RNG => comparable across edits.
//   node tools/ragdoll_settle.mjs
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';
import os from 'os';

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
const PORT = 8081;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=/tmp/ragsettle-chrome', '--window-size=900,600'] });
const errors = [];
const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE.ERROR: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    // Seed a deterministic LCG so the kill impulse / hit joint / twist are identical every run.
    let s = 1234567; Math.random = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  });
  const step = (n) => page.evaluate((n) => window.__step(n), n);
  await step(150);

  // Kill soldier 0 deterministically.
  await page.evaluate(() => {
    const em = window._APP.entityManager;
    const s = em.entities.find((e) => /UeSoldier/.test(e.Name));
    s.Broadcast({ topic: 'hit', amount: 999 });
  });

  const probe = () => page.evaluate(() => {
    const em = window._APP.entityManager;
    const sc = em.entities.find((e) => /UeSoldier/.test(e.Name)).GetComponent('UeSoldierController');
    const r = sc.ragdoll; if (!r || !r.nodes) return null;
    let cx = 0, cy = 0, cz = 0, minY = 1e9, maxY = -1e9;
    for (const n of r.nodes) { cx += n.p.x; cy += n.p.y; cz += n.p.z; minY = Math.min(minY, n.p.y); maxY = Math.max(maxY, n.p.y); }
    const k = 1 / r.nodes.length;
    const w = sc.droppedWeapon;
    return { c: [cx*k, cy*k, cz*k], minY:+minY.toFixed(3), maxY:+maxY.toFixed(3), asleep: !!r._asleep, age:+r._age.toFixed(2),
             wpY: w && w.object ? +w.object.position.y.toFixed(3) : null, wpAsleep: w ? !!w._asleep : null };
  });

  log('t(s)  centroidSpeed(m/s)  minY  maxY  asleep   weaponY  wpAsleep');
  let prev = await probe();
  for (let i = 0; i < 24; i++) {           // 24 * 0.5s = 12s
    await step(30);                         // 0.5s
    const cur = await probe();
    if (!cur) { log('  (no ragdoll)'); break; }
    let sp = 0;
    if (prev) { const dx=cur.c[0]-prev.c[0], dy=cur.c[1]-prev.c[1], dz=cur.c[2]-prev.c[2]; sp = Math.sqrt(dx*dx+dy*dy+dz*dz)/0.5; }
    log(`${cur.age.toFixed(1).padStart(4)}  ${sp.toFixed(3).padStart(8)}        ${cur.minY.toString().padStart(6)} ${cur.maxY.toString().padStart(6)}  ${String(cur.asleep).padStart(5)}   ${String(cur.wpY).padStart(6)}  ${cur.wpAsleep}`);
    prev = cur;
  }
  if (errors.length) { log('\n=== ERRORS ==='); errors.slice(0,20).forEach((e)=>log(e)); }
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); }
finally { await browser.close(); server.close(); }
