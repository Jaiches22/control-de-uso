import { fmtDuration } from '../../shared/core.ts';
import { $, el, send, type Status } from './lib/ui.ts';

function render(st: Status): void {
  $('login').hidden = st.loggedIn && !!st.device;
  $('main').hidden = !(st.loggedIn && !!st.device);
  if ($('main').hidden) return;

  $('who').textContent = `${st.device} · v${st.version}`;
  const box = $('limits');
  box.replaceChildren();
  const limits = st.state?.limits ?? [];
  if (limits.length === 0) {
    box.append(el('p', { className: 'muted', textContent: 'Todavía no hay límites. Crea el primero en «Configurar límites».' }));
    return;
  }
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
    render(await send({
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

$('openOptions').addEventListener('click', () => void chrome.runtime.openOptionsPage());

async function load(type: 'status' | 'refresh'): Promise<void> {
  try {
    render(await send({ type }));
  } catch (e) {
    $('mainError').textContent = e instanceof Error ? e.message : String(e);
  }
}
void load('status').then(() => load('refresh'));
