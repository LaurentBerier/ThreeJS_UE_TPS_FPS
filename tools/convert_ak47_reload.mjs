// Headless build step: drive tools/ak47_reload_to_glb.html in Edge to produce
// assets/guns/New/AK47_Reload.glb (the in-hand AK's magazine-reload clip).
// Mirrors convert_ue.mjs. Requires the dev server running (python serve.py) and
// puppeteer-core available.
//
//   node tools/convert_ak47_reload.mjs            (expects server on :8070)
//   PORT=8071 node tools/convert_ak47_reload.mjs
//
// puppeteer-core resolution: uses local node_modules, else PUPPETEER_DIR env.
import { writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || '8070';
const EDGE = process.env.EDGE ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const puppeteerDir = process.env.PUPPETEER_DIR || join(__dir, '..', 'node_modules', 'puppeteer-core');
const { default: puppeteer } = await import(pathToFileURL(join(puppeteerDir, 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).href)
  .catch(() => import('puppeteer-core'));

const url = `http://127.0.0.1:${PORT}/tools/ak47_reload_to_glb.html`;
const outPath = join(__dir, '..', 'assets', 'guns', 'New', 'AK47_Reload.glb');

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  console.log('Converting via', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => window.__STATUS && (window.__STATUS.ok === true || window.__STATUS.ok === false), { timeout: 120000 });
  const status = await page.evaluate(() => window.__STATUS);
  if (!status.ok) {
    console.error('Conversion failed:', status.error);
    if (errs.length) console.error('Page errors:', errs.join('\n'));
    process.exit(1);
  }
  const b64 = await page.evaluate(() => window.__GLB_B64);
  writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('Wrote', outPath, '(', status.bytes, 'bytes )');
  console.log('Clips:', JSON.stringify(status.clips));
} finally {
  await browser.close();
}
