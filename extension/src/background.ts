// Service worker: cuenta el tiempo de la pestaña activa, lo envía a Supabase y bloquea al agotarse un límite.
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import {
  addPending, creditedSeconds, effectiveRemaining, fmtDuration, keysFor, limitMatches, madridDay, sameKeys,
  type Key, type Limit, type Pending, type State,
} from './lib/core.ts';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

// En modo "split" hay un service worker aparte para las ventanas privadas: cada uno lleva su cuenta.
const INCOGNITO = chrome.extension?.inIncognitoContext ?? false;
const NS = INCOGNITO ? 'inc_' : '';
const K = { cur: NS + 'cur', pending: NS + 'pending', warned: NS + 'warned', state: 'state', device: 'device' };

const IDLE_SECONDS = 120;
const FLUSH_EVERY_MS = 28_000;
const RPC_TIMEOUT_MS = 10_000;
const RETRY_GAP_MS = 3_000;
const IDLE_REFRESH_MS = 120_000;
const OWN_ECHO_MS = 1_500;

interface Cur { keys: Key[]; since: number }

const sb = createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
  auth: {
    storageKey: 'sb-auth',
    storage: {
      getItem: async (k) => ((await chrome.storage.local.get(k))[k] as string | undefined) ?? null,
      setItem: async (k, v) => chrome.storage.local.set({ [k]: v }),
      removeItem: async (k) => chrome.storage.local.remove(k),
    },
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// ------------------------------------------------------------------ utilidades

let chain: Promise<unknown> = Promise.resolve();
/** Ejecuta las tareas de una en una para que no se pisen al leer y escribir el almacenamiento. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

async function rpc(name: string, args?: Record<string, unknown>): Promise<State> {
  const { data, error } = await sb.rpc(name, args).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
  if (error) throw new Error(error.message);
  return data as State;
}

async function hasSession(): Promise<boolean> {
  const { data } = await sb.auth.getSession();
  return !!data.session;
}

function blockedUrl(limit: Limit, url: string): string {
  return chrome.runtime.getURL(`blocked.html?l=${encodeURIComponent(limit.id)}&u=${encodeURIComponent(url)}`);
}

// ------------------------------------------------------------------ Realtime

let channel: RealtimeChannel | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function onRemoteChange(): void {
  // Los cambios que acaba de enviar este mismo dispositivo ya están aplicados: no hace falta volver a pedir el estado.
  if (Date.now() - lastFlushAt < OWN_ECHO_MS) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void tick({ refresh: true }), 400);
}

async function ensureRealtime(): Promise<void> {
  if (channel || !(await hasSession())) return;
  channel = sb.channel('cambios');
  for (const table of ['limit_usage', 'limits', 'limit_targets']) {
    channel.on('postgres_changes' as never, { event: '*', schema: 'public', table } as never, onRemoteChange);
  }
  channel.subscribe();
}

// ------------------------------------------------------------------ pestaña activa

async function getActive(): Promise<{ tabId: number; url: string } | null> {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused || win.id === undefined) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab || tab.id === undefined || !tab.url) return null;
  const idle = await chrome.idle.queryState(IDLE_SECONDS);
  if (idle === 'locked') return null;
  // Sin teclado ni ratón 2 minutos se deja de contar, salvo que la pestaña esté sonando (un vídeo en marcha).
  if (idle === 'idle' && !tab.audible) return null;
  return { tabId: tab.id, url: tab.url };
}

// ------------------------------------------------------------------ ciclo principal

let lastFlushAt = 0;
let lastAttemptAt = 0;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

interface TickOptions { flush?: boolean; refresh?: boolean }

function tick(opts: TickOptions = {}): Promise<void> {
  return locked(() => tickInner(opts)).catch((e) => console.warn('[control-de-uso] tick', e));
}

async function tickInner(opts: TickOptions): Promise<void> {
  const now = Date.now();
  const today = madridDay(new Date(now));
  const stored = await chrome.storage.local.get([K.cur, K.pending, K.warned, K.state, K.device]);
  const device = stored[K.device] as string | undefined;
  if (!device) return; // sin iniciar sesión no se cuenta nada
  let cur = (stored[K.cur] as Cur | undefined) ?? null;
  const pending = (stored[K.pending] as Pending | undefined) ?? {};
  let state = (stored[K.state] as State | undefined) ?? null;
  const warned = (stored[K.warned] as { day: string; ids: string[] } | undefined) ?? { day: today, ids: [] };
  if (warned.day !== today) { warned.day = today; warned.ids = []; }

  // 1. Cerrar el intervalo abierto.
  if (cur) {
    const elapsed = now - cur.since;
    if (elapsed >= 1000) {
      const secs = creditedSeconds(elapsed);
      addPending(pending, cur.keys, secs, today);
      // Se conserva la fracción de segundo que sobra; si el hueco era raro, se empieza de cero.
      cur.since = secs > 0 && elapsed < 61_000 ? cur.since + secs * 1000 : now;
    }
  }

  // 2. Enviar lo pendiente (o refrescar el estado) cuando toca.
  const hasPending = Object.keys(pending).length > 0;
  const stale = !state || state.day !== today;
  const due = opts.refresh || stale
    || (hasPending && (opts.flush || now - lastFlushAt > FLUSH_EVERY_MS))
    || (opts.flush && now - lastFlushAt > IDLE_REFRESH_MS);
  if (due && now - lastAttemptAt > RETRY_GAP_MS) {
    lastAttemptAt = now;
    try {
      state = hasPending
        ? await rpc('add_usage', { p_device: device, p_entries: Object.values(pending) })
        : await rpc('get_state');
      for (const id of Object.keys(pending)) delete pending[id];
      lastFlushAt = Date.now();
    } catch (e) {
      // Sin conexión: lo pendiente se queda guardado y se reintenta en el siguiente pulso.
      console.warn('[control-de-uso] sin sincronizar', e);
    }
  }

  // 3. Mirar la pestaña activa y aplicar los límites.
  const active = await getActive();
  let keys = active ? keysFor(active.url) : null;
  let nextWake = Infinity;
  if (active && keys && state) {
    const matching = state.limits.filter((l) => limitMatches(l, keys!));
    let exhausted: Limit | null = null;
    for (const limit of matching) {
      const left = effectiveRemaining(limit, state, pending, today);
      if (left <= 0) { exhausted = exhausted ?? limit; continue; }
      if (left <= 60 && !warned.ids.includes(limit.id)) {
        warned.ids.push(limit.id);
        chrome.notifications.create(`aviso-${limit.id}-${today}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'Control de uso',
          message: `Te queda ${fmtDuration(left)} de ${limit.name} por hoy.`,
        });
      }
      nextWake = Math.min(nextWake, left > 60 && !warned.ids.includes(limit.id) ? left - 60 : left);
    }
    if (exhausted) {
      await blockTabs(exhausted);
      keys = null;
      // Avisar ya al servidor para que el resto de dispositivos bloqueen también.
      if (Object.keys(pending).length > 0) setTimeout(() => void tick({ flush: true }), RETRY_GAP_MS + 100);
    }
  }

  // 4. Abrir el intervalo nuevo y guardar.
  cur = keys ? { keys, since: cur && sameKeys(cur.keys, keys) ? cur.since : now } : null;
  await chrome.storage.local.set({ [K.cur]: cur, [K.pending]: pending, [K.warned]: warned, [K.state]: state });

  // 5. Si el aviso o el bloqueo caen antes del siguiente pulso, despertarse justo entonces.
  clearTimeout(wakeTimer);
  if (cur && nextWake <= 31) {
    wakeTimer = setTimeout(() => void tick(), nextWake * 1000 + 150);
  }
}

/** Redirige a la página de aviso todas las pestañas abiertas del límite agotado. */
async function blockTabs(limit: Limit): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    const keys = keysFor(tab.url);
    if (!keys || !limitMatches(limit, keys)) continue;
    await chrome.tabs.update(tab.id, { url: blockedUrl(limit, tab.url) }).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ eventos

chrome.tabs.onActivated.addListener(() => void tick());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url !== undefined || info.audible !== undefined) void tick();
});
chrome.windows.onFocusChanged.addListener(() => void tick());
chrome.idle.onStateChanged.addListener(() => void tick());
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { if (d.frameId === 0) void tick(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pulso') void tick({ flush: true }); });

async function setup(): Promise<void> {
  chrome.idle.setDetectionInterval(IDLE_SECONDS);
  if (!(await chrome.alarms.get('pulso'))) {
    await chrome.alarms.create('pulso', { periodInMinutes: 0.5 });
  }
  await ensureRealtime();
  await tick({ refresh: true });
}
chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());
void setup();

// ------------------------------------------------------------------ mensajes de las páginas de la extensión

const ERRORS: Record<string, string> = {
  target_in_use: 'Esa web ya está en otro límite.',
  limit_not_found: 'Ese límite ya no existe.',
  invalid_daily_seconds: 'Los minutos tienen que estar entre 0 y 1440.',
  'Invalid login credentials': 'Email o contraseña incorrectos.',
};
const friendly = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return ERRORS[msg] ?? msg;
};

async function status() {
  const { data } = await sb.auth.getSession();
  const stored = await chrome.storage.local.get([K.pending, K.state, K.device]);
  const state = (stored[K.state] as State | undefined) ?? null;
  const pending = (stored[K.pending] as Pending | undefined) ?? {};
  const today = madridDay(new Date());
  const remaining: Record<string, number> = {};
  for (const l of state?.limits ?? []) remaining[l.id] = effectiveRemaining(l, state!, pending, today);
  return {
    loggedIn: !!data.session,
    email: data.session?.user.email ?? null,
    device: (stored[K.device] as string | undefined) ?? null,
    state,
    remaining,
    version: chrome.runtime.getManifest().version,
  };
}

async function saveState(state: State): Promise<void> {
  await locked(() => chrome.storage.local.set({ [K.state]: state }));
  await tick();
}

type Msg =
  | { type: 'status' }
  | { type: 'refresh' }
  | { type: 'login'; email: string; password: string; device: string }
  | { type: 'upsertLimit'; id: string | null; name: string; dailySeconds: number; allowExtra: boolean; targets: Key[] }
  | { type: 'deleteLimit'; id: string }
  | { type: 'cancelPending'; id: string };

async function handle(msg: Msg) {
  switch (msg.type) {
    case 'status':
      return status();
    case 'refresh':
      await tick({ refresh: true });
      return status();
    case 'login': {
      const device = msg.device.trim();
      if (!device) throw new Error('Pon un nombre a este dispositivo.');
      const { error } = await sb.auth.signInWithPassword({ email: msg.email.trim(), password: msg.password });
      if (error) throw new Error(error.message);
      await chrome.storage.local.set({ [K.device]: device });
      await ensureRealtime();
      await tick({ refresh: true });
      return status();
    }
    case 'upsertLimit':
      await saveState(await rpc('upsert_limit', {
        p_id: msg.id, p_name: msg.name, p_daily_seconds: msg.dailySeconds,
        p_allow_extra: msg.allowExtra, p_targets: msg.targets,
      }));
      return status();
    case 'deleteLimit':
      await saveState(await rpc('delete_limit', { p_id: msg.id }));
      return status();
    case 'cancelPending':
      await saveState(await rpc('cancel_pending', { p_id: msg.id }));
      return status();
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  handle(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: friendly(e) }),
  );
  return true;
});
