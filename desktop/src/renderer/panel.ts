import { fmtDuration, type State } from '../../../shared/core.ts';
import { describeTarget, el, initLimitsUI, type OpenApp } from '../../../shared/limits-ui.ts';

interface Status {
  loggedIn: boolean; email: string | null; device: string | null; state: State | null;
  remaining: Record<string, number>; version: string; foreground: string | null; platformError: string | null;
  extension: { dir: string; version: string | null };
}
interface Stats {
  bucket: Bucket; from: string; to: string;
  series: { start: string; seconds: number }[];
  top: { kind: 'domain' | 'win_process' | 'android_package' | 'special'; value: string; seconds: number }[];
}
type Bucket = 'day' | 'week' | 'month' | 'year';
declare const cdu: {
  send: (msg: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  onChange: (cb: () => void) => void;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
async function send<T>(msg: Record<string, unknown>): Promise<T> {
  const res = await cdu.send(msg);
  if (!res.ok) throw new Error(res.error);
  return res.result as T;
}

// ------------------------------------------------------------------ sesión y pestaña "Hoy"

function renderStatus(st: Status): void {
  const ready = st.loggedIn && !!st.device;
  $('login').hidden = ready;
  $('app').hidden = !ready;
  if (!ready) return;
  $('footer').textContent = `Sesión: ${st.email} · Dispositivo: ${st.device} · v${st.version}`;
  $('fg').textContent = st.platformError
    ? `No puedo ver qué app está en primer plano (${st.platformError}). Las apps de escritorio no se están contando.`
    : st.foreground ? `App en primer plano ahora: ${st.foreground}` : '';
  $('extDir').textContent = st.extension.dir;
  $('extVersion').textContent = st.extension.version ? `Versión en la carpeta: ${st.extension.version}` : 'La carpeta aún está vacía.';

  const box = $('today');
  box.replaceChildren();
  const limits = st.state?.limits ?? [];
  if (limits.length === 0) box.append(el('p', { className: 'muted', textContent: 'Todavía no hay límites. Crea el primero en «Límites».' }));
  for (const l of limits) {
    const left = st.remaining[l.id] ?? l.remaining_seconds;
    const pct = l.daily_seconds > 0 ? Math.round((left / l.daily_seconds) * 100) : 0;
    const bar = el('div', { className: 'bar' + (left <= 0 ? ' out' : left <= 60 ? ' low' : '') }, [el('div')]);
    (bar.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct))}%`;
    box.append(el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [
        el('strong', { textContent: l.name }),
        el('span', { textContent: left <= 0 ? 'Agotado' : `Quedan ${fmtDuration(left)}` }),
      ]),
      bar,
      el('div', { className: 'muted', textContent: `Límite: ${fmtDuration(l.daily_seconds)} al día` }),
    ]));
  }
}

$<HTMLFormElement>('login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $<HTMLButtonElement>('loginBtn');
  btn.disabled = true;
  $('loginError').textContent = '';
  try {
    limitsUI.render(await send<Status>({
      type: 'login',
      email: $<HTMLInputElement>('email').value,
      password: $<HTMLInputElement>('password').value,
      device: $<HTMLInputElement>('device').value,
    }));
  } catch (e) {
    $('loginError').textContent = e instanceof Error ? e.message : String(e);
  } finally {
    btn.disabled = false;
  }
});

const limitsUI = initLimitsUI<Status>({
  send: (msg) => send<Status>(msg),
  onStatus: renderStatus,
  listOpenApps: () => send<OpenApp[]>({ type: 'openApps' }),
});

// ------------------------------------------------------------------ pestañas

function selectTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll<HTMLElement>('section')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'stats') void loadStats();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('nav button')) b.addEventListener('click', () => selectTab(b.dataset.tab!));
$('openExt').addEventListener('click', () => void send({ type: 'openExtensionDir' }));

// ------------------------------------------------------------------ estadísticas

const COUNTS: Record<Bucket, number> = { day: 14, week: 12, month: 12, year: 5 };
let bucket: Bucket = 'day';
let filter: { kind: string; value: string; label: string } | null = null;

function bucketLabel(start: string, b: Bucket, long = false): string {
  const d = new Date(start + 'T12:00:00');
  if (b === 'year') return String(d.getFullYear());
  if (b === 'month') return d.toLocaleDateString('es-ES', long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
  const day = d.toLocaleDateString('es-ES', { day: 'numeric', month: long ? 'long' : 'numeric' });
  return b === 'week' && long ? `Semana del ${day}` : day;
}
const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toLocaleString('es-ES', { maximumFractionDigits: 1 })} h` : `${Math.round(s / 60)} min`);

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function drawChart(stats: Stats): void {
  const chart = document.getElementById('chart') as unknown as SVGSVGElement;
  const W = chart.clientWidth || 720, H = 240, left = 44, right = 8, top = 12, bottom = 24;
  chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
  chart.replaceChildren();
  const max = Math.max(...stats.series.map((p) => p.seconds), 60);
  // Escala con un tope "redondo" en horas o minutos.
  const unit = max >= 3600 ? 3600 : 60;
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 480, 1000, 2000, 5000];
  const step = steps.find((s) => (max / unit) / s <= 4) ?? 10000;
  const topValue = Math.ceil(max / unit / step) * step * unit;
  const plotH = H - top - bottom, plotW = W - left - right;
  const y = (v: number) => top + plotH - (v / topValue) * plotH;
  for (let v = 0; v <= topValue; v += step * unit) {
    chart.append(svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
    const t = svg('text', { x: left - 6, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = unit === 3600 ? `${v / 3600} h` : `${v / 60} min`;
    chart.append(t);
  }
  const slot = plotW / stats.series.length;
  const barW = Math.min(28, Math.max(4, slot - 6));
  const labelEvery = Math.ceil(stats.series.length / Math.max(1, Math.floor(plotW / 56)));
  const tip = $('tip');
  stats.series.forEach((p, i) => {
    const cx = left + slot * i + slot / 2;
    const h = (p.seconds / topValue) * plotH;
    const g = svg('g', {});
    g.append(svg('rect', { class: 'hit', x: left + slot * i, y: top, width: slot, height: plotH }));
    if (p.seconds > 0) {
      const r = Math.min(4, barW / 2, h);
      // Barra con la parte de arriba redondeada y la base recta, apoyada en el eje.
      const x0 = cx - barW / 2, x1 = cx + barW / 2, y0 = y(0), y1 = y0 - Math.max(h, 1);
      g.append(svg('path', { class: 'bar', d: `M${x0},${y0} V${y1 + r} Q${x0},${y1} ${x0 + r},${y1} H${x1 - r} Q${x1},${y1} ${x1},${y1 + r} V${y0} Z` }));
    }
    g.addEventListener('mousemove', (ev) => {
      tip.textContent = `${bucketLabel(p.start, stats.bucket, true)}: ${fmtDuration(p.seconds)}`;
      tip.style.display = 'block';
      tip.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - 220)}px`;
      tip.style.top = `${ev.clientY - 32}px`;
    });
    g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    chart.append(g);
    if ((stats.series.length - 1 - i) % labelEvery === 0) {
      const t = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = bucketLabel(p.start, stats.bucket);
      chart.append(t);
    }
  });
  const total = stats.series.reduce((a, p) => a + p.seconds, 0);
  chart.setAttribute('aria-label', `Tiempo por ${stats.bucket}: ${fmtDuration(total)} en total`);
}

async function loadStats(): Promise<void> {
  $('statsError').textContent = '';
  try {
    const stats = await send<Stats>({ type: 'stats', bucket, count: COUNTS[bucket], kind: filter?.kind, value: filter?.value });
    const total = stats.series.reduce((a, p) => a + p.seconds, 0);
    $('statsTitle').textContent = `${filter ? filter.label : 'Tiempo total'} · ${hours(total)} en este periodo`;
    $('statsAll').hidden = !filter;
    drawChart(stats);
    const top = $('top');
    top.replaceChildren();
    if (stats.top.length === 0) top.append(el('p', { className: 'muted', textContent: 'Aún no hay datos en este periodo.' }));
    const biggest = stats.top[0]?.seconds ?? 1;
    for (const item of stats.top) {
      const label = describeTarget(item);
      const bar = el('div', { className: 'bar' }, [el('div')]);
      (bar.firstElementChild as HTMLElement).style.width = `${Math.max(1, (item.seconds / biggest) * 100)}%`;
      const row = el('div', { className: 'toprow' }, [el('span', { textContent: label }), el('span', { className: 'muted', textContent: fmtDuration(item.seconds) }), bar]);
      row.addEventListener('click', () => { filter = { kind: item.kind, value: item.value, label }; void loadStats(); });
      top.append(row);
    }
  } catch (e) {
    $('statsError').textContent = e instanceof Error ? e.message : String(e);
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#buckets button')) {
  b.addEventListener('click', () => {
    bucket = b.dataset.bucket as Bucket;
    for (const o of document.querySelectorAll<HTMLButtonElement>('#buckets button')) o.setAttribute('aria-selected', String(o === b));
    void loadStats();
  });
}
$('statsAll').addEventListener('click', () => { filter = null; void loadStats(); });
window.addEventListener('resize', () => { if (!$('tab-stats').hidden) void loadStats(); });

// ------------------------------------------------------------------ arranque

cdu.onChange(() => void send<Status>({ type: 'status' }).then(limitsUI.render, () => undefined));
setInterval(() => void send<Status>({ type: 'status' }).then(renderStatus, () => undefined), 2000);
void send<Status>({ type: 'status' }).then(limitsUI.render).then(() => limitsUI.refresh());
