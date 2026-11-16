// Prueba de extremo a extremo en local: arranca la app de escritorio contra un Supabase simulado,
// con una "app en primer plano" falsa que se controla desde un archivo.
// Uso: SUPABASE_URL=http://localhost:8788 SUPABASE_ANON_KEY=test npm run build && xvfb-run -a node e2e/run.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import electronPath from 'electron';

const PORT = 8788, DEBUG_PORT = 9333;
const calls = [];
let limits = [];
let seq = 0;
const statsCalls = [];
let focus = null;
let extraGrants = 0;
const matches = (t, k) => t.kind === k.kind && (t.value === k.value || (t.kind === 'domain' && k.value.endsWith('.' + t.value)));
const state = () => ({
  day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date()),
  focus,
  server_time: new Date().toISOString(), resets_at: new Date(Date.now() + 3600_000).toISOString(),
  limits: limits.map((l) => ({ ...l, remaining_seconds: Math.max(l.daily_seconds - l.used_seconds, 0) })),
});
const rpc = {
  get_state: () => state(),
  add_usage: ({ p_entries }) => {
    for (const e of p_entries) {
      const keys = [{ kind: e.kind, value: e.value }, ...(e.also ?? [])];
      for (const l of limits) if (l.targets.some((t) => keys.some((k) => matches(t, k)))) l.used_seconds += e.seconds;
    }
    return state();
  },
  grant_extra: ({ p_limit_id }) => {
    const l = limits.find((x) => x.id === p_limit_id);
    l.daily_seconds += 300; l.extra_available = false; extraGrants++;
    return state();
  },
  start_focus: ({ p_limit_ids, p_minutes }) => {
    focus = { ends_at: new Date(Date.now() + p_minutes * 60000).toISOString(), limit_ids: p_limit_ids };
    return state();
  },
  upsert_limit: ({ p_name, p_daily_seconds, p_allow_extra, p_targets }) => {
    limits.push({ id: `l${++seq}`, name: p_name, daily_seconds: p_daily_seconds, used_seconds: 0, allow_extra: p_allow_extra, extra_available: p_allow_extra,
      pending_daily_seconds: null, pending_delete: false, pending_effective: null, targets: p_targets.map((t) => ({ ...t, remove_on: null })) });
    return state();
  },
  export_usage_csv: () => 'dia,tipo,nombre,dispositivo,segundos\n2026-11-14,win_process,"juego.exe","PC",8',
  get_app_meta: () => ({ 'android_package:com.instagram.android': { label: 'Instagram', icon: null } }),
  put_app_meta: () => null,
  get_stats_range: (args) => {
    statsCalls.push(args);
    const one = args.p_device;
    return {
      bucket: args.p_bucket ?? 'day', from: args.p_from, to: args.p_to, days: 14, today: '2026-11-14', total: 50000, previous_total: 62500,
      devices: ['PC', 'Móvil', 'Portátil'],
      series: Array.from({ length: 14 }, (_, i) => ({ start: `2026-11-${String(i + 1).padStart(2, '0')}`,
        devices: i === 0 ? {} : one ? { [one]: i * 300 } : { PC: i * 400, 'Móvil': i * 250, 'Portátil': i % 3 ? 0 : 600 } })),
      top: [
        { kind: 'win_process', value: 'juego.exe', seconds: 5000, devices: { PC: 4000, 'Portátil': 1000 } },
        { kind: 'android_package', value: 'com.instagram.android', seconds: 2400, devices: { 'Móvil': 2400 } },
        { kind: 'domain', value: 'prueba.invalid', seconds: 1200, devices: { PC: 1200 } },
        { kind: 'special', value: 'youtube_shorts', seconds: 900, devices: { 'Móvil': 900 } },
      ],
    };
  },
};
const jwt = (p) => ['{"alg":"HS256","typ":"JWT"}', JSON.stringify(p), 'sig'].map((s) => Buffer.from(s).toString('base64url')).join('.');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/auth/v1/token') {
      const { email, password } = JSON.parse(body || '{}');
      if (password !== 'correcta') return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: '11111111-1111-1111-1111-111111111111', aud: 'authenticated', role: 'authenticated', email };
      return json(200, { access_token: jwt({ sub: user.id, exp }), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      const args = JSON.parse(body || '{}');
      calls.push({ name, args });
      return rpc[name] ? json(200, rpc[name](args)) : json(404, { message: 'no rpc' });
    }
    json(404, {});
  });
}).listen(PORT);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cdu-e2e-'));
const fgFile = path.join(tmp, 'fg.json');
const setFg = (exe) => writeFileSync(fgFile, JSON.stringify({ exe, apps: [{ exe: 'juego.exe', title: 'Un juego' }, { exe: 'notas.exe', title: 'Notas' }] }));
setFg(null);
const extSrc = path.join(tmp, 'ext-src');
mkdirSync(extSrc);
writeFileSync(path.join(extSrc, 'manifest.json'), '{}');
writeFileSync(path.join(extSrc, 'version.json'), '{"version":"9.9.9"}');
const localAppData = path.join(tmp, 'local');

const child = spawn(electronPath, ['.', '--no-sandbox', `--remote-debugging-port=${DEBUG_PORT}`], {
  env: { ...process.env, CDU_EXPORT_PATH: path.join(tmp, 'export.csv'), CDU_FAKE_FOREGROUND: fgFile, CDU_USER_DATA: path.join(tmp, 'data'), CDU_EXTENSION_SRC: extSrc, LOCALAPPDATA: localAppData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null }); } catch { await sleep(500); }
  }
  throw new Error('Electron no arrancó');
}
const pageNamed = async (browser, file, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = (await browser.pages()).find((x) => x.url().endsWith(file));
    if (p) return p;
    await sleep(200);
  }
  throw new Error(`no aparece ${file}`);
};

const shot = (page, name) => Promise.race([page.screenshot({ path: path.join(tmp, name) }), sleep(8000)]);
let failed = false;
let browser;
try {
  browser = await connect();
  const panel = await pageNamed(browser, 'panel.html');

  // 1. Login.
  await panel.waitForSelector('#login:not([hidden])');
  await panel.type('#email', 'yo@example.com');
  await panel.type('#password', 'mala');
  await panel.type('#device', 'PC');
  await panel.click('#loginBtn');
  await panel.waitForFunction(() => document.querySelector('#loginError').textContent.includes('incorrectos'));
  await panel.$eval('#password', (e) => (e.value = ''));
  await panel.type('#password', 'correcta');
  await panel.click('#loginBtn');
  await panel.waitForSelector('#app:not([hidden])');
  console.log('ok  login');

  // 1b. Seguridad: el panel no puede navegar a una web ni abrir ventanas nuevas.
  const pagesBefore = (await browser.pages()).length;
  await panel.evaluate(() => { window.open('https://example.com'); location.href = 'https://example.com'; }).catch(() => undefined);
  await sleep(1500);
  assert.ok(panel.url().endsWith('panel.html'), panel.url());
  assert.equal((await browser.pages()).length, pagesBefore);
  console.log('ok  el panel no sale de sus páginas');

  // 2. La extensión se copió a su carpeta fija.
  const extDir = path.join(localAppData, 'ControlDeUso', 'extension');
  assert.equal(JSON.parse(readFileSync(path.join(extDir, 'version.json'), 'utf8')).version, '9.9.9');
  assert.ok(existsSync(path.join(extDir, 'manifest.json')));
  console.log('ok  carpeta de la extensión');

  // 3. Crear un límite desde el formulario eligiendo una app abierta; y avisos de validación.
  await panel.click('nav button[data-tab=limits]');
  await panel.type('#name', 'Juego');
  await panel.type('#minutes', '1');
  await panel.type('#domains', 'youtube.com');
  await panel.click('#shorts');
  await panel.click('#save');
  await panel.waitForFunction(() => document.querySelector('#error').textContent.includes('YouTube entero'));
  await panel.$eval('#domains', (e) => (e.value = ''));
  await panel.click('#shorts');
  await panel.click('#pickApp');
  await panel.waitForSelector('#openApps button.chip');
  await panel.click('#openApps button.chip');
  await panel.click('#save');
  await panel.waitForFunction(() => document.querySelector('#list').textContent.includes('app Windows juego.exe'));
  assert.deepEqual(limits[0].targets.map((t) => `${t.kind}:${t.value}`), ['win_process:juego.exe']);
  limits[0].daily_seconds = 8; // para no esperar un minuto
  limits[0].extra_available = true;
  await panel.evaluate(() => cdu.send({ type: 'refresh' }));
  console.log('ok  crear límite con app elegida de la lista');

  // 4. App sin límite: se cuenta para estadísticas y no se bloquea. Brave no se cuenta.
  setFg('notas.exe');
  await sleep(3200);
  setFg('brave.exe');
  await sleep(2200);

  // 5. App con límite de 8 s: aparece el aviso a pantalla completa.
  setFg('juego.exe');
  const t0 = Date.now();
  const overlay = await pageNamed(browser, 'overlay.html', 20000);
  await overlay.waitForFunction(() => document.querySelector('#title').textContent.includes('Se acabó Juego'), { timeout: 20000 });
  const took = (Date.now() - t0) / 1000;
  assert.ok(took >= 7 && took <= 12, `bloqueó a los ${took}s`);
  await sleep(1500);
  const juego = limits[0];
  assert.ok(juego.used_seconds >= 8 && juego.used_seconds <= 9, `usado ${juego.used_seconds}`);
  const visible = () => overlay.evaluate(() => document.visibilityState);
  assert.equal(await visible(), 'visible');
  console.log(`ok  aviso de bloqueo a los ${took.toFixed(1)} s, contados ${juego.used_seconds} s`);

  // 5b. +5 minutos desde el aviso: pulsación larga, cuenta atrás, y el aviso se quita.
  await overlay.waitForSelector('button.extra');
  const box = await (await overlay.$('button.extra')).boundingBox();
  await overlay.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await overlay.mouse.down(); await sleep(5400); await overlay.mouse.up();
  await overlay.waitForFunction(() => document.querySelector('button.extra')?.textContent.includes('cancelar'));
  const t1 = Date.now();
  while (extraGrants === 0 && Date.now() - t1 < 15000) await sleep(300);
  assert.equal(extraGrants, 1);
  await sleep(1800);
  assert.equal(await visible(), 'hidden');
  console.log('ok  +5 minutos desde el aviso');
  limits[0].daily_seconds = 0; // se vuelve a agotar
  await panel.evaluate(() => cdu.send({ type: 'refresh' }));
  await sleep(1800);
  assert.equal(await visible(), 'visible');
  assert.equal(await overlay.$('button.extra'), null);

  // 6. Al cambiar a otra app el aviso se quita; al volver, reaparece.
  setFg('notas.exe');
  await sleep(1800);
  assert.equal(await visible(), 'hidden');
  setFg('juego.exe');
  await sleep(1800);
  assert.equal(await visible(), 'visible');
  await shot(overlay, 'overlay.png');
  setFg(null);
  console.log('ok  el aviso sigue a la app bloqueada');

  // 7. Uso enviado: notas.exe sí, brave.exe no.
  await panel.evaluate(() => cdu.send({ type: 'refresh' }));
  const entries = calls.filter((c) => c.name === 'add_usage').flatMap((c) => c.args.p_entries);
  const total = (v) => entries.filter((e) => e.value === v).reduce((a, e) => a + e.seconds, 0);
  assert.ok(total('notas.exe') >= 3 && total('notas.exe') <= 7, `notas ${total('notas.exe')}`);
  assert.equal(total('brave.exe'), 0);
  assert.ok(entries.every((e) => e.kind === 'win_process'));
  console.log(`ok  estadísticas: notas.exe ${total('notas.exe')} s, brave.exe 0 s`);

  // 7b. Modo foco desde el panel: bloquea una app a la que le queda tiempo.
  const up = await panel.evaluate(() => cdu.send({ type: 'upsertLimit', id: null, name: 'Notas', dailySeconds: 3600, allowExtra: false, targets: [{ kind: 'win_process', value: 'notas.exe' }] }));
  assert.ok(up.ok, JSON.stringify(up));
  await panel.click('nav button[data-tab=focus]');
  await panel.waitForFunction(() => [...document.querySelectorAll('#focus label')].some((l) => l.textContent.includes('Notas')));
  await panel.evaluate(() => [...document.querySelectorAll('#focus label')].find((l) => l.textContent.includes('Notas')).querySelector('input').click());
  await panel.click('#focusStart');
  await panel.waitForFunction(() => document.querySelector('#focus').textContent.includes('Modo foco activo'));
  setFg('notas.exe');
  await overlay.waitForFunction(() => document.querySelector('#title').textContent.includes('modo foco'), { timeout: 8000 });
  setFg(null);
  console.log('ok  modo foco');

  // 7c. Exportar a CSV.
  await panel.click('nav button[data-tab=today]');
  await panel.click('#exportCsv');
  await panel.waitForFunction(() => document.querySelector('#exportMsg').textContent.includes('Guardado'));
  assert.ok(readFileSync(path.join(tmp, 'export.csv'), 'utf8').includes('juego.exe'));
  console.log('ok  exportar CSV');

  // 7d. Subir un límite ya asentado exige teclear la frase (y no deja pegarla).
  await panel.click('nav button[data-tab=limits]');
  await panel.evaluate(() => [...document.querySelectorAll('#list .card')].find((c) => c.textContent.includes('Notas')).querySelector('button').click());
  await panel.$eval('#minutes', (e) => (e.value = ''));
  await panel.type('#minutes', '90');
  const before = calls.filter((c) => c.name === 'upsert_limit').length;
  await panel.click('#save');
  await panel.waitForSelector('#frictionInput');
  assert.equal(await panel.$eval('#frictionOk', (b) => b.disabled), true);
  await panel.type('#frictionInput', 'puse este limite para proteger mi tiempo', { delay: 1 });
  assert.equal(await panel.$eval('#frictionOk', (b) => b.disabled), true);
  const phrase = await panel.$eval('.quote', (q) => q.textContent);
  await panel.$eval('#frictionInput', (e) => (e.value = ''));
  await panel.type('#frictionInput', phrase, { delay: 1 });
  assert.equal(await panel.$eval('#frictionOk', (b) => b.disabled), false);
  assert.equal(calls.filter((c) => c.name === 'upsert_limit').length, before);
  await panel.click('#frictionOk');
  await sleep(800);
  assert.equal(calls.filter((c) => c.name === 'upsert_limit').length, before + 1);
  console.log('ok  frase obligatoria para subir un límite');

  // 8. Panel: cifras, gráfica apilada por dispositivo, filtros y logos.
  await panel.click('nav button[data-tab=today]');
  await panel.waitForFunction(() => document.querySelectorAll('#tiles .tile').length === 4 && document.querySelectorAll('#chart path.bar').length > 20);
  assert.ok((await panel.$eval('#tiles', (t) => t.textContent)).includes('−20 %'));
  assert.equal(await panel.$$eval('#legend span', (n) => n.length), 3);
  await panel.waitForFunction(() => document.querySelector('#top').textContent.includes('Instagram'));
  await sleep(1500); // da tiempo a que falle el favicon de prueba y salga la inicial
  await shot(panel, 'panel.png');
  await panel.evaluate(() => [...document.querySelectorAll('#deviceFilter button')].find((b) => b.textContent.includes('Móvil')).click());
  await panel.waitForFunction(() => document.querySelectorAll('#legend span').length === 0);
  assert.equal(statsCalls.at(-1).p_device, 'Móvil');
  await panel.click('#ranges button[data-days="30"]');
  await sleep(600);
  const last = statsCalls.at(-1);
  assert.equal((new Date(last.p_to) - new Date(last.p_from)) / 86400000, 29);
  await panel.select('#bucketSel', 'week');
  await sleep(600);
  assert.equal(statsCalls.at(-1).p_bucket, 'week');
  await panel.click('nav button[data-tab=limits]');
  await shot(panel, 'limits.png');
  console.log('ok  estadísticas', tmp);
} catch (e) {
  failed = true;
  console.error('FALLO', e);
  console.error(JSON.stringify(limits), calls.map((c) => c.name).join(','));
} finally {
  if (log.trim()) console.error('--- salida de Electron ---\n' + log.split('\n').filter((l) => !/dbus|gpu|GL|Vulkan|viz/i.test(l)).slice(-15).join('\n'));
  await browser?.disconnect();
  child.kill('SIGKILL');
  server.close();
}
process.exit(failed ? 1 : 0);
