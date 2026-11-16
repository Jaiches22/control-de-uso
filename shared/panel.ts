// Panel de la app (Windows y Android). Cada plataforma pone su HTML y un objeto global `cdu` para hablar con su motor.
import { fmtClock, fmtDuration, inFocus, madridDay, type Key, type State } from './core.ts';
import { describeTarget, el, initLimitsUI, initPasswordToggle, type AppChoice } from './limits-ui.ts';

interface Status {
  loggedIn: boolean; email: string | null; device: string | null; state: State | null;
  remaining: Record<string, number>; version: string; foreground: string | null; platformError: string | null;
  platform: 'windows' | 'android';
  extension?: { dir: string; version: string | null };
  android?: {
    accessibility: boolean; notifications: boolean; battery: boolean; shorts: boolean; youtubeIds: string[];
    update?: { version: string } | null; updateMessage?: string | null;
  };
}
interface Stats {
  bucket: Bucket; from: string; to: string; days: number; total: number; previous_total: number;
  devices: string[];
  series: { start: string; devices: Record<string, number> }[];
  top: (Key & { seconds: number; devices: Record<string, number> })[];
  /** Nombre e icono de las apps, por "tipo:valor". Lo añade la parte nativa. */
  meta: Record<string, { label?: string | null; icon?: string | null }>;
}
type Bucket = 'day' | 'week' | 'month' | 'year';
declare const cdu: {
  platform: 'windows' | 'android';
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

let statsLoaded = false;

function renderStatus(st: Status): void {
  const ready = st.loggedIn && !!st.device;
  $('login').hidden = ready;
  $('app').hidden = !ready;
  document.body.classList.toggle('ready', ready);
  if (!ready) return;
  if (!statsLoaded) { statsLoaded = true; void loadStats(); }
  $('footer').textContent = `Sesión: ${st.email} · Dispositivo: ${st.device} · v${st.version}`;
  if (st.platform === 'android') $('fg').textContent = '';
  else $('fg').textContent = st.platformError
    ? `No puedo ver qué app está en primer plano (${st.platformError}). Las apps de escritorio no se están contando.`
    : st.foreground ? `App en primer plano ahora: ${st.foreground}` : '';
  if (st.extension) {
    $('extDir').textContent = st.extension.dir;
    $('extVersion').textContent = st.extension.version ? `Versión en la carpeta: ${st.extension.version}` : 'La carpeta aún está vacía.';
  }
  if (st.android) renderPermissions(st.android);

  const box = $('today');
  box.replaceChildren();
  const limits = st.state?.limits ?? [];
  $('todayTitle').hidden = limits.length === 0;
  for (const l of limits) {
    const left = st.remaining[l.id] ?? l.remaining_seconds;
    const pct = l.daily_seconds > 0 ? Math.round((left / l.daily_seconds) * 100) : 0;
    const bar = el('div', { className: 'bar' + (left <= 0 ? ' out' : left <= 60 ? ' low' : '') }, [el('div')]);
    (bar.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct))}%`;
    box.append(el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [
        el('strong', { textContent: l.name }),
        el('span', { textContent: st.state && inFocus(l, st.state) ? `En foco hasta las ${fmtClock(st.state.focus!.ends_at)}` : left <= 0 ? 'Agotado' : `Quedan ${fmtDuration(left)}` }),
      ]),
      bar,
      el('div', { className: 'muted', textContent: `Límite: ${fmtDuration(l.daily_seconds)} al día` + (l.suggested_daily_seconds ? ' · hay una sugerencia para bajarlo en «Límites»' : '') }),
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
  appKind: cdu.platform === 'android' ? 'android_package' : 'win_process',
  listApps: () => send<AppChoice[]>({ type: 'listApps' }),
});

// ------------------------------------------------------------------ permisos (solo Android)

function renderPermissions(a: NonNullable<Status['android']>): void {
  const update = document.getElementById('update');
  if (update) {
    update.hidden = !a.update;
    if (a.update) $('updateText').textContent = `Hay una versión nueva: ${a.update.version}.`;
    if (a.updateMessage) $('updateMsg').textContent = a.updateMessage;
  }
  const rows: [string, boolean, string][] = [
    ['permAccessibility', a.accessibility, 'accessibility'],
    ['permNotifications', a.notifications, 'notifications'],
    ['permBattery', a.battery, 'battery'],
  ];
  for (const [id, ok] of rows) {
    const node = document.getElementById(id);
    if (node) { node.textContent = ok ? 'Activado' : 'Falta'; node.className = ok ? 'ok' : 'tag'; }
  }
  const diag = document.getElementById('shortsDiag');
  if (diag) {
    diag.textContent = `Shorts detectado ahora: ${a.shorts ? 'sí' : 'no'}.`
      + (a.youtubeIds.length ? ` Pistas vistas en YouTube: ${a.youtubeIds.join(', ')}` : '');
  }
}
document.getElementById('updateBtn')?.addEventListener('click', async () => {
  const msg = $('updateMsg');
  msg.textContent = 'Descargando… Cuando Android pregunte, confirma la instalación.';
  try {
    await send({ type: 'installUpdate' });
  } catch (e) {
    msg.textContent = e instanceof Error ? e.message : String(e);
  }
});
for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-settings]')) {
  b.addEventListener('click', () => void send({ type: 'openSettings', which: b.dataset.settings }));
}

// ------------------------------------------------------------------ secciones

function selectTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll<HTMLElement>('section')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'today') void loadStats();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('nav button')) b.addEventListener('click', () => selectTab(b.dataset.tab!));
document.getElementById('openExt')?.addEventListener('click', () => void send({ type: 'openExtensionDir' }));

// ------------------------------------------------------------------ estadísticas

// Colores por dispositivo: paleta categórica validada sobre el fondo oscuro. El color va con el
// dispositivo (orden alfabético de todos los que existen), así no cambia al filtrar.
const DEVICE_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const OTHER_COLOR = '#6b7280';
let allDevices: string[] = [];
const deviceColor = (d: string) => DEVICE_COLORS[allDevices.indexOf(d)] ?? OTHER_COLOR;

let rangeDays = 7;                 // 0 = fechas a mano
let bucket: Bucket | null = null;  // null = automático
let device: string | null = null;
let filter: { kind: string; value: string; label: string } | null = null;
let statsSeq = 0;

function isoDaysAgo(n: number): string {
  const [y, m, d] = madridDay(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

function bucketLabel(start: string, b: Bucket, long = false): string {
  const d = new Date(start + 'T12:00:00');
  if (b === 'year') return String(d.getFullYear());
  if (b === 'month') return d.toLocaleDateString('es-ES', long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
  const day = d.toLocaleDateString('es-ES', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'numeric' });
  return b === 'week' && long ? `Semana del ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}` : day;
}
const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toLocaleString('es-ES', { maximumFractionDigits: 1 })} h` : `${Math.round(s / 60)} min`);

function itemLabel(item: Key, meta: Stats['meta']): string {
  const known = meta[`${item.kind}:${item.value}`]?.label;
  if (known) return known;
  if (item.kind === 'win_process') return item.value.replace(/\.exe$/, '').replace(/^./, (c) => c.toUpperCase());
  if (item.kind === 'android_package') return item.value.split('.').pop()!.replace(/^./, (c) => c.toUpperCase());
  return describeTarget(item);
}

/**
 * Logo de una web o app: el que subió el dispositivo que la conoce (la extensión saca el de las webs de la
 * caché del navegador; Windows y Android, el icono de la app). No se pide nada a ninguna web. Si no hay, una inicial.
 */
function itemIcon(item: Key, label: string, meta: Stats['meta']): HTMLElement {
  const letter = () => el('span', { className: 'icon letter', textContent: (label.trim()[0] ?? '?').toUpperCase() });
  const key = item.kind === 'special' ? 'domain:youtube.com' : `${item.kind}:${item.value}`;
  const src = meta[key]?.icon ?? null;
  if (!src || !src.startsWith('data:image/png;base64,')) return letter();
  const img = el('img', { className: 'icon', alt: '' });
  img.addEventListener('error', () => img.replaceWith(letter()), { once: true });
  img.src = src;
  return img;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Barras apiladas por dispositivo. Tramo de arriba redondeado, 2 px de separación entre tramos. */
function drawChart(stats: Stats): void {
  const chart = document.getElementById('chart') as unknown as SVGSVGElement;
  const W = chart.clientWidth || 720, H = 240, left = 46, right = 8, top = 12, bottom = 24;
  chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
  chart.replaceChildren();
  const totals = stats.series.map((p) => Object.values(p.devices).reduce((a, v) => a + v, 0));
  const max = Math.max(...totals, 60);
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
  const n = Math.max(stats.series.length, 1);
  const slot = plotW / n;
  const barW = Math.min(30, Math.max(3, slot - 6));
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(plotW / 56)));
  const tip = $('tip');
  stats.series.forEach((p, i) => {
    const cx = left + slot * i + slot / 2;
    const g = svg('g', {});
    g.append(svg('rect', { class: 'hit', x: left + slot * i, y: top, width: slot, height: plotH }));
    const parts = allDevices.filter((d) => (p.devices[d] ?? 0) > 0);
    let base = 0;
    parts.forEach((d, k) => {
      const v = p.devices[d];
      const y0 = y(base), y1 = y(base + v);
      base += v;
      const gap = k === 0 ? 0 : 2;                       // separación con el tramo de abajo
      const h = Math.max(y0 - gap - y1, 1);
      const x0 = cx - barW / 2, x1 = cx + barW / 2, yb = y1 + h;
      const r = k === parts.length - 1 ? Math.min(4, barW / 2, h) : 0;
      g.append(svg('path', {
        class: 'bar', fill: deviceColor(d),
        d: `M${x0},${yb} V${y1 + r} Q${x0},${y1} ${x0 + r},${y1} H${x1 - r} Q${x1},${y1} ${x1},${y1 + r} V${yb} Z`,
      }));
    });
    g.addEventListener('mousemove', (ev) => {
      const lines = [`${bucketLabel(p.start, stats.bucket, true)}: ${fmtDuration(totals[i])}`];
      if (parts.length > 1) for (const d of parts) lines.push(`${d}: ${fmtDuration(p.devices[d])}`);
      tip.textContent = lines.join('\n');
      tip.style.display = 'block';
      tip.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - 230)}px`;
      tip.style.top = `${Math.max(ev.clientY - 20 - 16 * lines.length, 4)}px`;
    });
    g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    chart.append(g);
    if ((n - 1 - i) % labelEvery === 0) {
      const t = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = bucketLabel(p.start, stats.bucket);
      chart.append(t);
    }
  });
  chart.setAttribute('aria-label', `Tiempo de uso por ${stats.bucket}: ${fmtDuration(stats.total)} en total`);

  // Leyenda: solo cuando hay más de un dispositivo en la gráfica.
  const shown = allDevices.filter((d) => stats.series.some((p) => (p.devices[d] ?? 0) > 0));
  const legend = $('legend');
  legend.replaceChildren();
  if (shown.length > 1) {
    for (const d of shown) {
      const sw = el('i');
      sw.style.background = deviceColor(d);
      legend.append(el('span', {}, [sw, d]));
    }
  }
}

function tile(k: string, v: string, s = ''): HTMLElement {
  return el('div', { className: 'tile' }, [
    el('div', { className: 'k', textContent: k }), el('div', { className: 'v', textContent: v, title: v }), el('div', { className: 's', textContent: s }),
  ]);
}

function renderFilters(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#ranges button')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === rangeDays));
  $('customRange').hidden = rangeDays !== 0;
  const box = $('deviceFilter');
  box.replaceChildren();
  if (allDevices.length < 2) return;
  const chip = (label: string, value: string | null) => {
    const b = el('button', { type: 'button', textContent: label });
    b.setAttribute('aria-pressed', String(device === value));
    if (value) {
      const sw = el('i');
      sw.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;background:${deviceColor(value)}`;
      b.prepend(sw);
    }
    b.addEventListener('click', () => { device = value; void loadStats(); });
    return b;
  };
  box.append(chip('Todos', null), ...allDevices.map((d) => chip(d, d)));
}

async function loadStats(): Promise<void> {
  const seq = ++statsSeq;
  $('statsError').textContent = '';
  const from = rangeDays ? isoDaysAgo(rangeDays - 1) : $<HTMLInputElement>('from').value || isoDaysAgo(6);
  const to = rangeDays ? isoDaysAgo(0) : $<HTMLInputElement>('to').value || isoDaysAgo(0);
  try {
    const stats = await send<Stats>({ type: 'stats', from, to, bucket, device, kind: filter?.kind ?? null, value: filter?.value ?? null });
    if (seq !== statsSeq) return; // llegó tarde: ya hay otra petición más nueva
    allDevices = [...stats.devices].sort((a, b) => a.localeCompare(b, 'es'));
    if (device && !allDevices.includes(device)) device = null;
    renderFilters();

    const avg = stats.days > 0 ? stats.total / stats.days : 0;
    const prev = stats.previous_total;
    const change = prev > 0 ? Math.round(((stats.total - prev) / prev) * 100) : null;
    const tiles = $('tiles');
    tiles.replaceChildren(
      tile(filter ? filter.label : 'Tiempo total', hours(stats.total), `${stats.days} ${stats.days === 1 ? 'día' : 'días'}${device ? ' · ' + device : ''}`),
      tile('Media diaria', hours(avg), 'en este periodo'),
      tile('Frente al periodo anterior',
        change === null ? 'Sin datos' : change === 0 ? 'Igual' : `${change < 0 ? '−' : '+'}${Math.abs(change)} %`,
        change === null ? 'no hay uso registrado antes' : `${change < 0 ? 'menos' : change > 0 ? 'más' : 'lo mismo'} que antes (${hours(prev)})`),
      tile('Lo más usado', stats.top[0] ? itemLabel(stats.top[0], stats.meta) : 'Nada aún', stats.top[0] ? hours(stats.top[0].seconds) : ''),
    );
    $('chartTitle').textContent = filter ? `Evolución de ${filter.label}` : 'Evolución del tiempo de uso';
    $('statsAll').hidden = !filter;
    drawChart(stats);

    const top = $('top');
    top.replaceChildren();
    if (stats.top.length === 0) top.append(el('p', { className: 'muted', textContent: 'Aún no hay datos en este periodo.' }));
    const biggest = stats.top[0]?.seconds ?? 1;
    for (const item of stats.top) {
      const label = itemLabel(item, stats.meta);
      const bar = el('div', { className: 'bar' }, [el('div')]);
      (bar.firstElementChild as HTMLElement).style.width = `${Math.max(1, (item.seconds / biggest) * 100)}%`;
      const devs = el('div', { className: 'dev' });
      const used = allDevices.filter((d) => (item.devices[d] ?? 0) > 0);
      if (used.length > 1 || (used.length === 1 && allDevices.length > 1)) {
        for (const d of used) {
          const sw = el('i');
          sw.style.background = deviceColor(d);
          devs.append(el('span', {}, [sw, `${d} ${hours(item.devices[d])}  `]));
        }
      }
      const row = el('div', { className: 'toprow' }, [
        itemIcon(item, label, stats.meta),
        el('span', { className: 'name', textContent: label, title: item.value }),
        el('span', { className: 'muted', textContent: fmtDuration(item.seconds) }),
        devs, bar,
      ]);
      row.addEventListener('click', () => { filter = { kind: item.kind, value: item.value, label }; void loadStats(); });
      top.append(row);
    }
  } catch (e) {
    if (seq === statsSeq) $('statsError').textContent = e instanceof Error ? e.message : String(e);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#ranges button')) {
  b.addEventListener('click', () => {
    rangeDays = Number(b.dataset.days);
    if (rangeDays === 0) {
      $<HTMLInputElement>('from').value ||= isoDaysAgo(29);
      $<HTMLInputElement>('to').value ||= isoDaysAgo(0);
    }
    void loadStats();
  });
}
for (const id of ['from', 'to']) $(id).addEventListener('change', () => void loadStats());
$<HTMLSelectElement>('bucketSel').addEventListener('change', (ev) => {
  const v = (ev.target as HTMLSelectElement).value;
  bucket = v === 'auto' ? null : (v as Bucket);
  void loadStats();
});
$('statsAll').addEventListener('click', () => { filter = null; void loadStats(); });
document.getElementById('exportCsv')?.addEventListener('click', async () => {
  const msg = $('exportMsg');
  msg.textContent = 'Preparando…';
  try {
    const res = await send<{ saved: boolean; path?: string }>({ type: 'exportCsv' });
    msg.textContent = res.saved ? `Guardado${res.path ? ' en ' + res.path : ''}.` : '';
  } catch (e) {
    msg.textContent = e instanceof Error ? e.message : String(e);
  }
});
window.addEventListener('resize', () => { if (!$('tab-today').hidden && !$('app').hidden) void loadStats(); });
setInterval(() => { if (!$('tab-today').hidden && !$('app').hidden && document.visibilityState === 'visible') void loadStats(); }, 60_000);

// ------------------------------------------------------------------ arranque

initPasswordToggle();

cdu.onChange(() => void send<Status>({ type: 'status' }).then(limitsUI.render, () => undefined));
setInterval(() => void send<Status>({ type: 'status' }).then(renderStatus, () => undefined), 2000);
void send<Status>({ type: 'status' }).then(limitsUI.render).then(() => limitsUI.refresh());
