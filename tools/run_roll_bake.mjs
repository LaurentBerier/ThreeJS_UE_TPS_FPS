// One-shot headless bake of the forward-roll clip into
// assets/characters/ue/RollForward.glb. Self-contained: serves the project root
// over http, drives tools/roll_to_glb.html in the cached Chrome for Testing via
// puppeteer-core, and writes the GLB the page produces.
//
//   node tools/run_roll_bake.mjs
//
// Needs network (the page pulls three@0.160 from unpkg) and a Chrome binary:
// uses $CHROME_BIN if set, else the puppeteer cache's Chrome for Testing.
import { writeFileSync, existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';
import os from 'os';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const OUT = join(ROOT, 'assets', 'characters', 'ue', 'RollForward.glb');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.fbx': 'application/octet-stream', '.glb': 'model/gltf-binary',
  '.json': 'application/json', '.wasm': 'application/wasm',
};

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  // The cached Chrome for Testing app.
  const candidates = [
    join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Fallback: scan the cache dir for any version.
  return null;
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/roll_to_glb.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' });
  res.end(readFileSync(fpath));
});

const PORT = 8077;
await new Promise((r) => server.listen(PORT, r));
console.log('serving', ROOT, 'on', PORT);

const { default: puppeteer } = await import('puppeteer-core');
let exe = findChrome();
if (!exe) {
  // Last resort: let puppeteer-core try the bundled resolver.
  console.error('Could not locate Chrome for Testing; set CHROME_BIN.');
  process.exit(2);
}
console.log('chrome:', exe);

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  dumpio: true,
  pipe: true,
  protocolTimeout: 180000,
  timeout: 120000,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--user-data-dir=/tmp/roll-bake-chrome',
  ],
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const url = `http://127.0.0.1:${PORT}/tools/roll_to_glb.html`;
  console.log('navigating', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => window.__STATUS && (window.__STATUS.ok === true || window.__STATUS.ok === false), { timeout: 120000 });
  const st = await page.evaluate(() => window.__STATUS);
  if (!st.ok) {
    console.error('Conversion failed:', st.error);
    if (errs.length) console.error('Page errors:\n' + errs.join('\n'));
    process.exit(1);
  }
  const b64 = await page.evaluate(() => window.__GLB_B64);
  writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('Wrote', OUT, '(', st.bytes, 'bytes )');
  console.log('Clips:', JSON.stringify(st.clips));
} finally {
  await browser.close();
  server.close();
}
