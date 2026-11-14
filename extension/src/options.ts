import { initLimitsUI } from '../../shared/limits-ui.ts';
import { $, send, type Status } from './lib/ui.ts';

const ui = initLimitsUI<Status>({
  send,
  onStatus: (st) => {
    $('footer').textContent = st.loggedIn
      ? `Sesión: ${st.email} · Dispositivo: ${st.device} · v${st.version}`
      : 'Sin sesión: inicia sesión desde el icono de la extensión.';
  },
});
void ui.refresh();
