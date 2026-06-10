// Load-failure diagnostic: open index.html against the REAL dev server (8070 by default) in headless
// Edge and log every failed/again request + console error, so we can see the EXACT url that "Failed to
// fetch". Does NOT start its own server — points at the running serve.py so it reproduces the user's env.
//   PORT=8070 node tools/load_diag.mjs
const PORT = process.env.PORT || '8070';
const exe = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const log = (...a) => console.log(...a);
try {
  const page = await browser.newPage();
  const failed = [];
  page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText || '??'}  ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}  ${r.url()}`); });
  page.on('pageerror', (e) => log('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE.ERR:', m.text()); });

  log('loading http://127.0.0.1:' + PORT + '/index.html ...');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  // Click start and wait for the world to build (or fail).
  try {
    await page.evaluate(() => document.getElementById('start_game')?.click());
    await page.waitForFunction(() => window._APP && window._APP.entityManager && window._APP.entityManager.entities.length > 5, { timeout: 45000 });
    log('RESULT: game loaded OK — entities:', await page.evaluate(() => window._APP.entityManager.entities.length));
  } catch (e) {
    log('RESULT: game did NOT finish loading:', e.message);
  }
  log('\n=== FAILED / 4xx REQUESTS (' + failed.length + ') ===');
  failed.forEach((f) => log('  ' + f));
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }
