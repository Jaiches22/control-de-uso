import { fmtDuration } from '../../../shared/core.ts';

interface OverlayData { name: string; detail: string; resetsAt: string | null; app: string }
declare const cdu: { onOverlay: (cb: (d: OverlayData) => void) => void };

let resetsAt: string | null = null;
const set = (id: string, text: string) => { document.getElementById(id)!.textContent = text; };

function renderReset(): void {
  const ms = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
  set('reset', ms > 0 ? `Se reinicia a las 00:00 (faltan ${fmtDuration(Math.ceil(ms / 60000) * 60)}).` : 'Se reinicia a las 00:00.');
}

cdu.onOverlay((d) => {
  set('title', `Se acabó ${d.name} por hoy`);
  set('detail', d.detail);
  resetsAt = d.resetsAt;
  renderReset();
});
setInterval(renderReset, 30_000);
