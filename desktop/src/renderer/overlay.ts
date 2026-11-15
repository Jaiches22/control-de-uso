import { fmtDuration } from '../../../shared/core.ts';
import { mountExtraButton } from '../../../shared/extra-button.ts';

interface OverlayData { id: string; title: string; detail: string; resetsAt: string | null; extra: boolean }
declare const cdu: {
  onOverlay: (cb: (d: OverlayData) => void) => void;
  send: (msg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
};

let resetsAt: string | null = null;
const node = (id: string) => document.getElementById(id)!;

function renderReset(): void {
  if (!resetsAt) { node('reset').textContent = ''; return; }
  const ms = new Date(resetsAt).getTime() - Date.now();
  node('reset').textContent = ms > 0 ? `Se reinicia a las 00:00 (faltan ${fmtDuration(Math.ceil(ms / 60000) * 60)}).` : 'Se reinicia a las 00:00.';
}

cdu.onOverlay((d) => {
  node('title').textContent = d.title;
  node('detail').textContent = d.detail;
  resetsAt = d.resetsAt;
  renderReset();
  const extra = node('extra');
  if (d.extra) {
    mountExtraButton(extra, async () => {
      const res = await cdu.send({ type: 'grantExtra', id: d.id });
      if (!res.ok) throw new Error(res.error);
    });
  } else {
    extra.replaceChildren();
  }
});
setInterval(renderReset, 30_000);
