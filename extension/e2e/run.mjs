// Prueba de extremo a extremo en local: carga la extensión compilada en Chrome contra un Supabase simulado.
// Uso: SUPABASE_URL=http://localhost:8787 SUPABASE_ANON_KEY=test npm run build && xvfb-run -a node e2e/run.mjs
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const PORT = 8787;
const calls = [];
let limits = [];
let seq = 0;

const matches = (t, k) => t.kind === k.kind && (t.value === k.value || (t.kind === 'domain' && k.value.endsWith('.' + t.value)));
const state = () => ({
  day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date()),
  server_time: new Date().toISOString(),
  resets_at: new Date(Date.now() + 3600_000).toISOString(),
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
  upsert_limit: ({ p_name, p_daily_seconds, p_allow_extra, p_targets }) => {
    limits.push({
      id: `l${++seq}`, name: p_name, daily_seconds: p_daily_seconds, used_seconds: 0, allow_extra: p_allow_extra,
      pending_daily_seconds: null, pending_delete: false, pending_effective: null,
      targets: p_targets.map((t) => ({ ...t, remove_on: null })),
    });
    return state();
  },
};

const jwt = (payload) => ['{"alg":"HS256","typ":"JWT"}', JSON.stringify(payload), 'sig']
  .map((s) => Buffer.from(s).toString('base64url')).join('.');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'OPTIONS') return json(200, {});
    if (url.pathname === '/auth/v1/token') {
      const { email, password } = JSON.parse(body || '{}');
      if (password !== 'correcta') return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: '11111111-1111-1111-1111-111111111111', aud: 'authenticated', role: 'authenticated', email };
      return json(200, { access_token: jwt({ sub: user.id, exp, role: 'authenticated' }), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      const args = JSON.parse(body || '{}');
      calls.push({ name, args, auth: req.headers.authorization });
      return rpc[name] ? json(200, rpc[name](args)) : json(404, { message: 'no rpc' });
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>sitio ${req.headers.host}</title><h1>${url.pathname}</h1>`);
  });
}).listen(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = path.resolve('dist');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', '--no-first-run',
    `--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP *.prueba.test 127.0.0.1, MAP prueba.test 127.0.0.1`],
});
let failed = false;
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const swErrors = [];
  const worker = await sw.worker();
  worker.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

  // 1. Login: contraseña mala y luego buena.
  const popup = await browser.newPage();
  await popup.goto(`${base}/popup.html`);
  await popup.waitForSelector('#login:not([hidden])');
  await popup.type('#email', 'yo@example.com');
  await popup.type('#password', 'mala');
  await popup.type('#device', 'PC');
  await popup.click('#loginBtn');
  await popup.waitForFunction(() => document.querySelector('#loginError').textContent.includes('incorrectos'));
  await popup.$eval('#password', (e) => (e.value = ''));
  await popup.type('#password', 'correcta');
  await popup.click('#loginBtn');
  await popup.waitForSelector('#main:not([hidden])');
  console.log('ok  login');

  // 2. Crear límites: uno por el formulario y dos cortos por mensaje (para no esperar minutos).
  const options = await browser.newPage();
  await options.goto(`${base}/options.html`);
  await options.type('#name', 'Formulario');
  await options.type('#minutes', '1');
  await options.type('#domains', 'https://www.otro.prueba.test/x, ');
  await options.click('#save');
  await options.waitForFunction(() => document.querySelector('#list').textContent.includes('Formulario'));
  assert.deepEqual(limits[0].targets.map((t) => t.value), ['otro.prueba.test']);
  assert.equal(limits[0].daily_seconds, 60);
  for (const [name, dailySeconds, targets] of [
    ['Corto', 8, [{ kind: 'domain', value: 'prueba.test' }]],
    ['Shorts', 0, [{ kind: 'special', value: 'youtube_shorts' }]],
  ]) {
    const r = await options.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'upsertLimit', id: null, name, dailySeconds, allowExtra: false, targets });
    assert.ok(r.ok, JSON.stringify(r));
  }
  console.log('ok  crear límites');

  // 3. Un sitio con 8 s de límite: se cuenta y se bloquea solo.
  const site = await browser.newPage();
  const t0 = Date.now();
  await site.goto(`http://www.prueba.test:${PORT}/hola`);
  await site.bringToFront();
  await site.waitForFunction(() => location.protocol === 'chrome-extension:' && location.pathname === '/blocked.html', { timeout: 30000 });
  const took = (Date.now() - t0) / 1000;
  await site.waitForFunction(() => document.querySelector('#title').textContent.includes('Se acabó Corto'));
  assert.ok(took >= 7 && took <= 13, `bloqueó a los ${took}s`);
  const corto = limits.find((l) => l.name === 'Corto');
  assert.ok(corto.used_seconds >= 8 && corto.used_seconds <= 10, `usado ${corto.used_seconds}`);
  console.log(`ok  bloqueo a los ${took.toFixed(1)} s, contados ${corto.used_seconds} s`);

  // 4. Volver a entrar: bloqueo inmediato.
  await site.goto(`http://sub.prueba.test:${PORT}/otra`).catch(() => undefined);
  await site.waitForFunction(() => location.pathname === '/blocked.html', { timeout: 5000 });
  console.log('ok  rebloqueo inmediato (subdominio incluido)');

  // 5. Shorts bloqueado, YouTube normal no.
  const yt = await browser.newPage();
  await yt.goto(`http://www.youtube.com:${PORT}/watch`);
  await yt.bringToFront();
  await sleep(2500);
  assert.ok(yt.url().includes('/watch'), yt.url());
  await yt.goto(`http://www.youtube.com:${PORT}/shorts/abc`).catch(() => undefined);
  await yt.waitForFunction(() => location.pathname === '/blocked.html', { timeout: 5000 });
  await yt.waitForFunction(() => document.querySelector('#title').textContent.includes('Se acabó Shorts'));
  console.log('ok  Shorts bloqueado, YouTube normal no');

  // 6. Navegación interna (pushState) hacia Shorts.
  await yt.goto(`http://www.youtube.com:${PORT}/watch`);
  await yt.evaluate(() => history.pushState({}, '', '/shorts/def'));
  await yt.waitForFunction(() => location.pathname === '/blocked.html', { timeout: 5000 });
  console.log('ok  Shorts por navegación interna');

  // 7. El uso llevó token de sesión y dispositivo; YouTube normal se registró para estadísticas.
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'refresh' }));
  const usage = calls.filter((c) => c.name === 'add_usage');
  assert.ok(usage.length > 0 && usage.every((c) => c.auth?.startsWith('Bearer ey') && c.args.p_device === 'PC'));
  const all = usage.flatMap((c) => c.args.p_entries);
  assert.ok(all.some((e) => e.value === 'youtube.com' && !e.also), 'falta youtube.com en estadísticas');
  assert.deepEqual(swErrors, []);
  console.log(`ok  ${calls.length} llamadas RPC, sin errores en el service worker`);
} catch (e) {
  failed = true;
  console.error('FALLO', e);
  for (const p of await browser.pages()) console.error('  pestaña', p.url());
  console.error(JSON.stringify(limits), calls.length);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
