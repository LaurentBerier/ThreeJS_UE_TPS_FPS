// Screenshot the TPS crouch-idle pose + a few frames of the standing->crouch transition,
// so the authored crouch_idle clip can be eyeballed. Writes PNGs to /tmp.
//   node tools/shot_crouchidle.mjs
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
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
const PORT = 8095;
await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN ||
  join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=/tmp/shotci-chrome', '--window-size=900,700'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => !!window._APP, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('start_game').click());
  await page.waitForFunction(() => window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 30000 });
  // Drive the sim by hand but KEEP rendering on for the screenshots.
  await page.evaluate(() => {
    if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId);
    window._APP.OnAnimationFrameHandler = () => {};
    window.__press = (c) => document.dispatchEvent(new KeyboardEvent('keydown', { code: c }));
    window.__release = (c) => document.dispatchEvent(new KeyboardEvent('keyup', { code: c }));
    window.__step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) { window._APP.Step(dt); } };
    window.__render = () => window._APP.renderer.render(window._APP.scene, window._APP.camera);
  });
  // Step in small chunks so no single CDP call runs long enough to hit protocolTimeout.
  const step = async (n) => { for (let done = 0; done < n; done += 20) { await page.evaluate((k) => window.__step(k), Math.min(20, n - done)); } };
  const press = (c) => page.evaluate((c) => window.__press(c), c);
  const release = (c) => page.evaluate((c) => window.__release(c), c);
  const shot = async (name) => { await page.evaluate(() => window.__render()); const f = `/tmp/crouchidle_${name}.png`; await page.screenshot({ path: f }); console.log('wrote', f); };

  await step(260);                       // settle + FootIK calibration
  await shot('00_standing');
  await press('KeyC'); await step(1); await release('KeyC');
  await step(3);  await shot('01_enter_f3');
  await step(5);  await shot('02_enter_f8');
  await step(10); await shot('03_enter_f18');
  await step(50); await shot('04_crouch_idle_settled');
  // Crouch-walk, then back to crouch-idle to check the boundary.
  await press('KeyW'); await step(40); await shot('05_crouch_walk');
  await release('KeyW'); await step(45); await shot('06_back_to_crouch_idle');
  // Stand back up.
  await press('KeyC'); await step(1); await release('KeyC'); await step(40); await shot('07_stood_up');
  console.log('done');
} catch (e) {
  console.error('FATAL', e);
} finally {
  await browser.close();
  server.close();
}
