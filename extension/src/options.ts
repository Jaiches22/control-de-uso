import { fmtDuration, normalizeDomain, SHORTS, type Key, type Limit } from './lib/core.ts';
import { $, el, send, type Status } from './lib/ui.ts';

let limits: Limit[] = [];
let editing: Limit | null = null;

const isShorts = (k: Key) => k.kind === SHORTS.kind && k.value === SHORTS.value;
const showError = (e: unknown) => { $('error').textContent = e instanceof Error ? e.message : String(e); };

function describeTargets(l: Limit): string {
  const parts = l.targets.map((t) => {
    const name = isShorts(t) ? 'YouTube Shorts'
      : t.kind === 'domain' ? t.value
      : t.kind === 'android_package' ? `app Android ${t.value}`
      : t.kind === 'win_process' ? `app Windows ${t.value}` : t.value;
    return t.remove_on ? `${name} (se quita mañana)` : name;
  });
  return parts.length ? parts.join(', ') : 'Sin webs ni apps';
}

function render(st: Status): void {
  limits = st.state?.limits ?? [];
  $('footer').textContent = st.loggedIn
    ? `Sesión: ${st.email} · Dispositivo: ${st.device} · v${st.version}`
    : 'Sin sesión: inicia sesión desde el icono de la extensión.';
  const list = $('list');
  list.replaceChildren();
  if (limits.length === 0) list.append(el('p', { className: 'muted', textContent: 'No hay límites todavía.' }));
  for (const l of limits) {
    const left = st.remaining[l.id] ?? l.remaining_seconds;
    const notes: string[] = [];
    if (l.pending_delete) notes.push('Se borra a las 00:00.');
    else if (l.pending_daily_seconds !== null) notes.push(`Sube a ${fmtDuration(l.pending_daily_seconds)} a las 00:00.`);
    const hasPending = l.pending_delete || l.pending_daily_seconds !== null || l.targets.some((t) => t.remove_on);

    const edit = el('button', { textContent: 'Editar' });
    edit.addEventListener('click', () => startEdit(l));
    const del = el('button', { textContent: 'Borrar' });
    del.addEventListener('click', () => act({ type: 'deleteLimit', id: l.id }));
    const buttons: HTMLElement[] = [edit, del];
    if (hasPending) {
      const cancel = el('button', { textContent: 'Cancelar cambios pendientes' });
      cancel.addEventListener('click', () => act({ type: 'cancelPending', id: l.id }));
      buttons.push(cancel);
    }
    list.append(el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [
        el('strong', { textContent: l.name }),
        el('span', { textContent: `${fmtDuration(l.daily_seconds)} al día · ${left <= 0 ? 'agotado' : 'quedan ' + fmtDuration(left)}` }),
      ]),
      el('p', { className: 'muted', textContent: describeTargets(l) }),
      el('p', { className: 'tag', textContent: notes.join(' ') }),
      el('div', {}, buttons.flatMap((b) => [b, ' '])),
    ]));
  }
}

function startEdit(l: Limit | null): void {
  editing = l;
  $('formTitle').textContent = l ? `Editar «${l.name}»` : 'Nuevo límite';
  $('cancelEdit').hidden = !l;
  $<HTMLInputElement>('name').value = l?.name ?? '';
  $<HTMLInputElement>('minutes').value = l ? String(Math.round(l.daily_seconds / 60)) : '';
  const active = l?.targets.filter((t) => !t.remove_on) ?? [];
  $<HTMLInputElement>('domains').value = active.filter((t) => t.kind === 'domain').map((t) => t.value).join(', ');
  $<HTMLInputElement>('shorts').checked = active.some(isShorts);
  $<HTMLInputElement>('extra').checked = l?.allow_extra ?? false;
  const others = active.filter((t) => t.kind === 'android_package' || t.kind === 'win_process');
  $('otherTargets').textContent = others.length
    ? `También incluye apps (se conservan): ${others.map((t) => t.value).join(', ')}`
    : '';
  if (l) $('form').scrollIntoView({ behavior: 'smooth' });
}

async function act(msg: Record<string, unknown>): Promise<boolean> {
  $('error').textContent = '';
  try {
    render(await send(msg));
    return true;
  } catch (e) {
    showError(e);
    return false;
  }
}

$<HTMLFormElement>('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const targets: Key[] = [];
  for (const raw of $<HTMLInputElement>('domains').value.split(/[,\s]+/).filter(Boolean)) {
    const d = normalizeDomain(raw);
    if (!d) return showError(`«${raw}» no parece un dominio. Ejemplo: instagram.com`);
    if (!targets.some((t) => t.value === d)) targets.push({ kind: 'domain', value: d });
  }
  if ($<HTMLInputElement>('shorts').checked) targets.push(SHORTS);
  // Las apps de Android y Windows de este límite no se editan aquí: se conservan tal cual.
  for (const t of editing?.targets ?? []) {
    if (!t.remove_on && (t.kind === 'android_package' || t.kind === 'win_process')) targets.push({ kind: t.kind, value: t.value });
  }
  if (targets.length === 0) return showError('Añade al menos una web o marca YouTube Shorts.');
  const minutes = Number($<HTMLInputElement>('minutes').value);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return showError('Los minutos tienen que estar entre 0 y 1440.');

  const ok = await act({
    type: 'upsertLimit',
    id: editing?.id ?? null,
    name: $<HTMLInputElement>('name').value.trim(),
    dailySeconds: Math.round(minutes * 60),
    allowExtra: $<HTMLInputElement>('extra').checked,
    targets,
  });
  if (ok) startEdit(null);
});

$('cancelEdit').addEventListener('click', () => startEdit(null));
void act({ type: 'refresh' });
setInterval(() => { if (!editing) void send({ type: 'status' }).then(render, () => undefined); }, 15_000);
