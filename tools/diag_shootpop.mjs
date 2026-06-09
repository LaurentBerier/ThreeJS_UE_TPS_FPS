// Headless diagnostic: find the per-frame "pop" during continuous TPS fire.
// Boots the real game, forces the player to fire continuously in TPS at several aim-yaw
// offsets (hipfire + ADS), and records each frame's WORLD-orientation delta for every
// upper-body bone + the gun. Spikes (a frame whose delta >> the running median) localize
// the pop to a specific bone and a specific phase of the shoot-clip loop.
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import http from 'http';
import os from 'os';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.jpg':'image/jpeg','.fbx':'application/octet-stream','.wav':'audio/wav','.tga':'application/octet-stream','.obj':'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const fpath = join(ROOT, p);
  if (!fpath.startsWith(ROOT) || !existsSync(fpath) || statSync(fpath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(fpath)] || 'application/octet-stream' }); res.end(readFileSync(fpath));
});
const PORT = 8079; await new Promise((r) => server.listen(PORT, r));
const exe = process.env.CHROME_BIN || join(os.homedir(), '.cache/puppeteer/chrome/mac-135.0.7049.95/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--no-first-run','--no-default-browser-check','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--user-data-dir=/tmp/diag-chrome','--window-size=900,600'] });
const errors = []; const log = (...a) => console.log(...a);
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
  await page.evaluate(() => { if (window._APP.animFrameId) window.cancelAnimationFrame(window._APP.animFrameId); window.__step=(n,dt=1/60)=>{for(let i=0;i<n;i++)window._APP.Step(dt);}; });
  await page.evaluate((n)=>window.__step(n), 150); // settle onto floor + AI spin-up

  const runCase = async (aiming, sideYaw) => page.evaluate(async ({ aiming, sideYaw }) => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const pc = player.GetComponent('PlayerControls');
    const body = player.GetComponent('PlayerBody');
    const wm = player.GetComponent('WeaponManager');
    const Q = body.model.quaternion.constructor;
    body.cameraMode = 'TPS'; pc.cameraMode = 'TPS'; pc.aiming = aiming;
    // Force a PERSISTENT extreme body-vs-aim offset: body faces 0, look points to sideYaw.
    body.UpdateBodyYaw = function(){ this._bodyYaw = 0; this.modelRoot.rotation.set(0,0,0); };
    pc.UpdateAimTarget = function(){
      this.camera && this.camera.updateMatrixWorld(); this.camera && this.camera.getWorldPosition(this.aimOrigin);
      this.aimDir.set(Math.sin(sideYaw), -0.05, Math.cos(sideYaw)).normalize(); this.aimDirRaw.copy(this.aimDir);
      this._aimDistSmooth = 10; this.aimDistance = 10; this.aimTargetValid = true;
      this.aimTarget.copy(this.aimOrigin).addScaledVector(this.aimDir, 10);
    };
    const names = ['hand_r','hand_l','lowerarm_l','upperarm_l','lowerarm_r','upperarm_r','spine_01','spine_02','spine_03','head'];
    const bones = {}; body.model.traverse(o => { if (o.isBone && names.includes(o.name) && !bones[o.name]) bones[o.name] = o; });
    const pivot = body.weaponPivot;
    const dot = (a,b)=>a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w;
    const angBetween = (a,b)=>2*Math.acos(Math.min(1,Math.abs(dot(a,b))))*180/Math.PI;
    const prev = {}; const series = {}; for (const n of names) series[n] = []; series.gun = [];
    const frames = [];
    let prevGun = null;
    // warm up a few frames so fire state engages, before recording
    for (let w=0; w<10; w++){ wm.active.shoot = true; wm.active.magAmmo = 999; wm.active.reloading = false; window._APP.Step(1/60); }
    for (let i = 0; i < 240; i++) {
      wm.active.shoot = true; wm.active.magAmmo = 999; wm.active.reloading = false;
      window._APP.Step(1/60);
      body.model.updateMatrixWorld(true);
      for (const n of names) { const q = bones[n].getWorldQuaternion(new Q()); if (prev[n]) series[n].push(angBetween(prev[n], q)); prev[n] = q; }
      const gq = pivot.getWorldQuaternion(new Q()); if (prevGun) series.gun.push(angBetween(prevGun, gq)); prevGun = gq;
      const sa = body.upperActions && body.upperActions['shoot'];
      frames.push({ st: sa ? +sa.time.toFixed(3) : null, alpha: body.weaponAimIK ? +body.weaponAimIK._alpha.toFixed(2) : null, os: body.oneShot, hold: +(body._shootHold||0).toFixed(2) });
    }
    const stats = (arr) => {
      const s = [...arr].sort((a,b)=>a-b); const med = s[Math.floor(s.length/2)] || 0; const p90 = s[Math.floor(s.length*0.9)] || 0;
      let max = 0, maxi = -1; for (let k=0;k<arr.length;k++) if (arr[k] > max) { max = arr[k]; maxi = k; }
      const thr = Math.max(med * 5 + 0.5, p90 * 3); const spikes = [];
      for (let k=0;k<arr.length;k++) if (arr[k] > thr) spikes.push(k);
      return { med:+med.toFixed(3), p90:+p90.toFixed(3), max:+max.toFixed(2), maxi, nSpikes: spikes.length,
        spikeStimes: spikes.slice(0,10).map(k => ({ d:+arr[k].toFixed(2), st: frames[k+1] ? frames[k+1].st : null })) };
    };
    const out = {}; for (const n of Object.keys(series)) out[n] = stats(series[n]);
    const dur = (body.upperActions['shoot'] && body.upperActions['shoot'].getClip().duration) || null;
    return { out, dur, sampleFrames: frames.slice(0, 8) };
  }, { aiming, sideYaw });

  const cases = [
    { label: 'HIPFIRE straight (yaw 0)', aiming: false, yaw: 0 },
    { label: 'HIPFIRE side (yaw 1.0rad/57deg)', aiming: false, yaw: 1.0 },
    { label: 'HIPFIRE extreme (yaw 1.4rad/80deg)', aiming: false, yaw: 1.4 },
    { label: 'ADS side (yaw 1.0rad/57deg)', aiming: true, yaw: 1.0 },
  ];
  for (const c of cases) {
    const r = await runCase(c.aiming, c.yaw);
    log('\n===== ' + c.label + '  (shoot clip dur=' + r.dur + 's) =====');
    // Sort bones by max per-frame delta, show the worst few + their spike phases.
    const rows = Object.entries(r.out).sort((a,b) => b[1].max - a[1].max);
    for (const [name, s] of rows) {
      const flag = s.nSpikes > 0 ? `  <<< ${s.nSpikes} SPIKES @st=${JSON.stringify(s.spikeStimes)}` : '';
      log(`  ${name.padEnd(11)} med=${String(s.med).padStart(6)}  p90=${String(s.p90).padStart(6)}  MAX=${String(s.max).padStart(7)}°/frame${flag}`);
    }
  }
  if (errors.length) { log('\n--- page errors (' + errors.length + ') ---'); errors.slice(0,15).forEach(e=>log(e)); }
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); }
finally { await browser.close(); server.close(); }
