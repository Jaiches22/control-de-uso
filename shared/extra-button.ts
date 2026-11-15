// Botón «+5 minutos» de las pantallas de bloqueo: hay que mantenerlo pulsado 5 segundos y después
// esperar una cuenta atrás de 10 segundos que se puede cancelar. Así pedir el extra nunca es un impulso.
const HOLD_MS = 5000;
const COUNTDOWN_S = 10;

export function mountExtraButton(box: HTMLElement, grant: () => Promise<void>): void {
  box.replaceChildren();
  const btn = document.createElement('button');
  const note = document.createElement('p');
  note.className = 'muted';
  const idle = 'Mantén pulsado 5 s para +5 minutos';
  btn.textContent = idle;
  btn.className = 'extra';
  note.textContent = 'Solo una vez al día entre todos tus dispositivos.';
  box.append(btn, note);

  let holdTimer: ReturnType<typeof setInterval> | undefined;
  let countTimer: ReturnType<typeof setInterval> | undefined;
  let phase: 'idle' | 'holding' | 'counting' | 'granting' = 'idle';

  const reset = (text = idle) => {
    clearInterval(holdTimer);
    clearInterval(countTimer);
    phase = 'idle';
    btn.textContent = text;
    btn.disabled = false;
  };

  const startCountdown = () => {
    phase = 'counting';
    let left = COUNTDOWN_S;
    const show = () => { btn.textContent = `+5 minutos en ${left} s · toca para cancelar`; };
    show();
    countTimer = setInterval(async () => {
      left -= 1;
      if (left > 0) return show();
      clearInterval(countTimer);
      phase = 'granting';
      btn.disabled = true;
      btn.textContent = 'Concediendo…';
      try {
        await grant();
        btn.textContent = 'Hecho';
      } catch (e) {
        note.textContent = e instanceof Error ? e.message : String(e);
        reset();
      }
    }, 1000);
  };

  const down = (ev: Event) => {
    ev.preventDefault();
    if (phase === 'counting') return reset();
    if (phase !== 'idle') return;
    phase = 'holding';
    const t0 = Date.now();
    holdTimer = setInterval(() => {
      const left = HOLD_MS - (Date.now() - t0);
      if (left > 0) { btn.textContent = `Sigue pulsando… ${Math.ceil(left / 1000)}`; return; }
      clearInterval(holdTimer);
      startCountdown();
    }, 100);
  };
  const up = () => { if (phase === 'holding') reset(); };

  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
}
