import { fmtClock, fmtDuration, inFocus } from '../../shared/core.ts';
import { mountExtraButton } from '../../shared/extra-button.ts';
import { $, send } from './lib/ui.ts';

const params = new URLSearchParams(location.search);
const limitId = params.get('l');
const original = params.get('u');
const originalIsWeb = !!original && /^https?:\/\//i.test(original);
let extraShown = false;

if (originalIsWeb) {
  try { $('where').textContent = `Intentabas abrir ${new URL(original!).hostname}`; } catch { /* URL rara: no se muestra */ }
}

async function update(type: 'status' | 'refresh'): Promise<void> {
  let st;
  try { st = await send({ type }); } catch { return; }
  const limit = st.state?.limits.find((l) => l.id === limitId);
  const left = limit ? (st.remaining[limit.id] ?? limit.remaining_seconds) : 1;
  const back = $<HTMLAnchorElement>('back');
  const extra = $('extra');
  if (!limit || left > 0) {
    $('title').textContent = 'Ya puedes volver';
    $('detail').textContent = limit ? `Vuelves a tener ${fmtDuration(left)} de ${limit.name}.` : 'Este límite ya no existe.';
    $('reset').textContent = '';
    extra.replaceChildren();
    extraShown = false;
    if (originalIsWeb) { back.href = original!; back.hidden = false; }
    return;
  }
  back.hidden = true;
  if (inFocus(limit, st.state!)) {
    $('title').textContent = `${limit.name} está en modo foco`;
    $('detail').textContent = `Lo bloqueaste tú hasta las ${fmtClock(st.state!.focus!.ends_at)}.`;
    $('reset').textContent = '';
    extra.replaceChildren();
    extraShown = false;
    return;
  }
  $('title').textContent = `Se acabó ${limit.name} por hoy`;
  $('detail').textContent = `Has gastado tu tiempo de hoy (${fmtDuration(limit.daily_seconds)}) entre todos tus dispositivos.`;
  const ms = new Date(st.state!.resets_at).getTime() - Date.now();
  $('reset').textContent = ms > 0
    ? `Se reinicia a las 00:00 (faltan ${fmtDuration(Math.ceil(ms / 60000) * 60)}).`
    : 'Se reinicia a las 00:00.';
  if (limit.extra_available && !extraShown) {
    extraShown = true;
    mountExtraButton(extra, async () => {
      await send({ type: 'grantExtra', id: limit.id });
      if (originalIsWeb) location.href = original!; else await update('status');
    });
  } else if (!limit.extra_available) {
    extra.replaceChildren();
    extraShown = false;
  }
}

void update('refresh');
setInterval(() => void update(Date.now() % 60_000 < 15_000 ? 'refresh' : 'status'), 15_000);
