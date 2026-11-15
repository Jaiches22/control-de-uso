// Lista y formulario de límites. Lo comparten la extensión y la app de Windows: mismo HTML (mismos id),
// distinta forma de hablar con el motor (mensajes de extensión o IPC de Electron).
import { fmtDuration, normalizeDomain, SHORTS, type Key, type Limit, type State } from './core.ts';

export interface LimitsStatus { state: State | null; remaining: Record<string, number> }
/** Una app elegible: id es lo que se guarda (proceso .exe o paquete Android) y label lo que se enseña. */
export interface AppChoice { id: string; label: string }
export interface LimitsOptions<S extends LimitsStatus> {
  send: (msg: Record<string, unknown>) => Promise<S>;
  onStatus?: (st: S) => void;
  /** Qué tipo de app se edita en esta pantalla (campo #apps). Sin él, las apps solo se conservan. */
  appKind?: 'win_process' | 'android_package';
  /** Apps para elegir de una lista: las abiertas (Windows) o las instaladas (Android). */
  listApps?: () => Promise<AppChoice[]>;
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
function need<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = byId<T>(id);
  if (!node) throw new Error(`Falta #${id}`);
  return node;
}
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Botón «Ver» junto al campo de contraseña del login, para comprobar lo que se está escribiendo. */
export function initPasswordToggle(): void {
  const input = byId<HTMLInputElement>('password');
  const btn = byId<HTMLButtonElement>('togglePassword');
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Ocultar' : 'Ver';
    btn.setAttribute('aria-pressed', String(show));
    input.focus();
  });
}

const isShorts = (k: Key) => k.kind === SHORTS.kind && k.value === SHORTS.value;
const isYouTube = (d: string) => d === 'youtube.com' || d.endsWith('.youtube.com');

/** Limpia lo que se escriba como proceso de Windows: 'Spotify.EXE ' -> 'spotify.exe'. */
export function normalizeProcess(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^.*[\\/]/, '');
  if (!s) return null;
  if (!s.endsWith('.exe')) s += '.exe';
  return /^[^<>:"|?*\s][^<>:"|?*]*\.exe$/.test(s) ? s : null;
}

export function normalizePackage(input: string): string | null {
  const s = input.trim();
  return /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(s) ? s : null;
}

export function describeTarget(t: Key): string {
  if (isShorts(t)) return 'YouTube Shorts';
  if (t.kind === 'android_package') return `app Android ${t.value}`;
  if (t.kind === 'win_process') return `app Windows ${t.value}`;
  return t.value;
}

export function initLimitsUI<S extends LimitsStatus>(opts: LimitsOptions<S>): { refresh: () => Promise<void>; render: (st: S) => void } {
  let editing: Limit | null = null;
  const appKind = opts.appKind ?? null;
  const appsInput = appKind ? byId<HTMLInputElement>('apps') : null;
  const otherAppKind = appKind === 'win_process' ? 'android_package' : appKind === 'android_package' ? 'win_process' : null;
  const showError = (e: unknown) => { need('error').textContent = e instanceof Error ? e.message : String(e); };

  function render(st: S): void {
    opts.onStatus?.(st);
    const limits = st.state?.limits ?? [];
    const list = need('list');
    list.replaceChildren();
    if (limits.length === 0) list.append(el('p', { className: 'muted', textContent: 'No hay límites todavía.' }));
    for (const l of limits) {
      const left = st.remaining[l.id] ?? l.remaining_seconds;
      const notes: string[] = [];
      if (l.pending_delete) notes.push('Se borra a las 00:00.');
      else if (l.pending_daily_seconds !== null) notes.push(`Sube a ${fmtDuration(l.pending_daily_seconds)} a las 00:00.`);
      const hasPending = l.pending_delete || l.pending_daily_seconds !== null || l.targets.some((t) => t.remove_on);
      const targets = l.targets.map((t) => (t.remove_on ? `${describeTarget(t)} (se quita a las 00:00)` : describeTarget(t)));

      const edit = el('button', { textContent: 'Editar', type: 'button' });
      edit.addEventListener('click', () => startEdit(l));
      const del = el('button', { textContent: 'Borrar', type: 'button' });
      del.addEventListener('click', () => void act({ type: 'deleteLimit', id: l.id }));
      const buttons: HTMLElement[] = [edit, del];
      if (hasPending) {
        const cancel = el('button', { textContent: 'Cancelar cambios pendientes', type: 'button' });
        cancel.addEventListener('click', () => void act({ type: 'cancelPending', id: l.id }));
        buttons.push(cancel);
      }
      list.append(el('div', { className: 'card' }, [
        el('div', { className: 'row' }, [
          el('strong', { textContent: l.name }),
          el('span', { textContent: `${fmtDuration(l.daily_seconds)} al día · ${left <= 0 ? 'agotado' : 'quedan ' + fmtDuration(left)}` }),
        ]),
        el('p', { className: 'muted', textContent: targets.length ? targets.join(', ') : 'Sin webs ni apps' }),
        el('p', { className: 'tag', textContent: notes.join(' ') }),
        el('div', {}, buttons.flatMap((b) => [b, ' '])),
      ]));
    }
  }

  function startEdit(l: Limit | null): void {
    editing = l;
    need('formTitle').textContent = l ? `Editar «${l.name}»` : 'Nuevo límite';
    need('cancelEdit').hidden = !l;
    need<HTMLInputElement>('name').value = l?.name ?? '';
    need<HTMLInputElement>('minutes').value = l ? String(Math.round(l.daily_seconds / 60)) : '';
    const active = l?.targets.filter((t) => !t.remove_on) ?? [];
    const values = (kind: string) => active.filter((t) => t.kind === kind).map((t) => t.value);
    need<HTMLInputElement>('domains').value = values('domain').join(', ');
    need<HTMLInputElement>('shorts').checked = active.some(isShorts);
    need<HTMLInputElement>('extra').checked = l?.allow_extra ?? false;
    if (appsInput && appKind) appsInput.value = values(appKind).join(', ');
    const kept = appsInput && otherAppKind ? values(otherAppKind) : [...values('android_package'), ...values('win_process')];
    need('otherTargets').textContent = kept.length ? `También incluye apps (se conservan): ${kept.join(', ')}` : '';
    if (l) need('form').scrollIntoView({ behavior: 'smooth' });
  }

  async function act(msg: Record<string, unknown>): Promise<boolean> {
    need('error').textContent = '';
    try {
      render(await opts.send(msg));
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  }

  need<HTMLFormElement>('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const targets: Key[] = [];
    const add = (k: Key) => { if (!targets.some((t) => t.kind === k.kind && t.value === k.value)) targets.push(k); };
    const split = (s: string) => s.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

    for (const raw of split(need<HTMLInputElement>('domains').value.replace(/\s+/g, ','))) {
      const d = normalizeDomain(raw);
      if (!d) return showError(`«${raw}» no parece un dominio. Ejemplo: instagram.com`);
      add({ kind: 'domain', value: d });
    }
    const shorts = need<HTMLInputElement>('shorts').checked;
    if (shorts && targets.some((t) => isYouTube(t.value))) {
      return showError('Has puesto youtube.com y además Shorts: así se limita YouTube entero. Para limitar solo Shorts, borra youtube.com de «Webs».');
    }
    if (shorts && appsInput && appKind === 'android_package'
        && appsInput.value.split(',').some((x) => x.trim() === 'com.google.android.youtube')) {
      return showError('Has puesto la app de YouTube y además Shorts: así se limita YouTube entero. Para limitar solo Shorts, quita la app de YouTube.');
    }
    if (shorts) add(SHORTS);
    if (appsInput && appKind) {
      for (const raw of split(appsInput.value)) {
        const p = appKind === 'win_process' ? normalizeProcess(raw) : normalizePackage(raw);
        if (!p) {
          return showError(appKind === 'win_process'
            ? `«${raw}» no parece un programa. Ejemplo: spotify.exe`
            : `«${raw}» no parece una app. Elígela de la lista.`);
        }
        add({ kind: appKind, value: p });
      }
    }
    // Lo que esta pantalla no sabe editar se conserva tal cual.
    for (const t of editing?.targets ?? []) {
      if (t.remove_on) continue;
      const editable = t.kind === 'domain' || t.kind === 'special' || (appsInput && t.kind === appKind);
      if (!editable) add({ kind: t.kind, value: t.value });
    }
    if (targets.length === 0) return showError('Añade al menos una web o una app, o marca YouTube Shorts.');
    const minutes = Number(need<HTMLInputElement>('minutes').value);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return showError('Los minutos tienen que estar entre 0 y 1440.');

    const ok = await act({
      type: 'upsertLimit',
      id: editing?.id ?? null,
      name: need<HTMLInputElement>('name').value.trim(),
      dailySeconds: Math.round(minutes * 60),
      allowExtra: need<HTMLInputElement>('extra').checked,
      targets,
    });
    if (ok) startEdit(null);
  });

  need('cancelEdit').addEventListener('click', () => startEdit(null));

  // Elegir apps de una lista.
  const pick = byId<HTMLButtonElement>('pickApp');
  const openApps = byId('openApps');
  if (pick && openApps && appsInput && opts.listApps) {
    pick.addEventListener('click', async () => {
      openApps.replaceChildren(el('span', { className: 'muted', textContent: 'Buscando apps…' }));
      try {
        const apps = await opts.listApps!();
        openApps.replaceChildren();
        if (apps.length === 0) openApps.append(el('span', { className: 'muted', textContent: 'No he encontrado apps.' }));
        for (const app of apps) {
          const chip = el('button', { type: 'button', className: 'chip', textContent: app.label, title: app.id });
          chip.addEventListener('click', () => {
            const current = appsInput.value.split(',').map((x) => x.trim()).filter(Boolean);
            if (!current.includes(app.id)) current.push(app.id);
            appsInput.value = current.join(', ');
          });
          openApps.append(chip, ' ');
        }
      } catch (e) {
        openApps.replaceChildren();
        showError(e);
      }
    });
  }

  const refresh = async () => { await act({ type: 'refresh' }); };
  setInterval(() => { if (!editing) void opts.send({ type: 'status' }).then(render, () => undefined); }, 15_000);
  return { refresh, render };
}
