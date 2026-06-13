// Measure the head-bone world-Y drop standing -> crouch-idle (to size crouchCamDrop), and the
// per-frame camera-Y delta through the transition (smoothness). node tools/measure_crouchhead.mjs
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
const PORT = 8096; await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=/tmp/meashead-chrome', '--window-size=900,600'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window._APP.OnAnimationFrameHandler = () => {}; window._APP.renderer.render = () => {};
    const P = () => window._APP.entityManager.Get('Player');
    window.__press = (c) => document.dispatchEvent(new KeyboardEvent('keydown', { code: c }));
    window.__release = (c) => document.dispatchEvent(new KeyboardEvent('keyup', { code: c }));
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) window._APP.Step(dt); };
    window.__head = () => { let h = null; P().GetComponent('PlayerBody').model.traverse(o => { if (o.isBone && o.name === 'head') h = o; }); const v = new (window._APP.camera.position.constructor)(); h.getWorldPosition(v); return +v.y.toFixed(4); };
    window.__camY = () => +window._APP.camera.position.y.toFixed(4);
    window.__headSample = (n) => { const out = []; for (let i = 0; i < n; i++) { window.__step(1); out.push({ head: window.__head(), cam: window.__camY() }); } return out; };
  });
  const step = async (n) => { for (let d = 0; d < n; d += 20) await page.evaluate((k) => window.__step(k), Math.min(20, n - d)); };
  await step(260);
  const standHead = await page.evaluate(() => window.__head());
  const standCam = await page.evaluate(() => window.__camY());
  await page.evaluate(() => { window.__press('KeyC'); window.__step(1); window.__release('KeyC'); });
  const tr = await page.evaluate(() => window.__headSample(60));
  const crouchHead = tr[tr.length - 1].head, crouchCam = tr[tr.length - 1].cam;
  console.log('standing  head Y =', standHead, ' cam Y =', standCam);
  console.log('crouched  head Y =', crouchHead, ' cam Y =', crouchCam);
  console.log('HEAD DROP =', (standHead - crouchHead).toFixed(4), 'm   CAM DROP =', (standCam - crouchCam).toFixed(4), 'm');
  let maxCamStep = 0; for (let i = 1; i < tr.length; i++) maxCamStep = Math.max(maxCamStep, Math.abs(tr[i].cam - tr[i - 1].cam));
  console.log('max cam-Y step through transition =', (maxCamStep * 1000).toFixed(1), 'mm/frame');
  console.log('head trace:', tr.slice(0, 20).map(s => s.head).join(' '));
} catch (e) { console.error('FATAL', e); } finally { await browser.close(); server.close(); }
