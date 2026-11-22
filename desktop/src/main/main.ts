// Proceso principal: bandeja, panel, aviso de bloqueo, carpeta de la extensión y actualizaciones.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from 'electron';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fmtClock, fmtDuration, inFocus, type Limit, type State } from '../../../shared/core.ts';
import { Engine } from './engine.ts';
import { createPlatform, platformError, type Foreground } from './platform.ts';
import { authStorage, loadData, saveData } from './store.ts';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

const APP_ID = 'es.jaimecalzada.controldeuso';
const startHidden = process.argv.includes('--hidden');

// Ganchos para las pruebas automáticas. En la app instalada no hacen nada, para que nadie pueda
// cambiar su comportamiento con variables de entorno.
const TEST = !app.isPackaged;
if (TEST && process.env.CDU_USER_DATA) app.setPath('userData', process.env.CDU_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let overlayKey = '';
let engine: Engine;
const notices = new Map<string, Notification>();
let loadDataPaths: () => Record<string, string> = () => ({});
const platform = createPlatform(TEST);

// ------------------------------------------------------------------ carpeta de la extensión

function extensionDir(): string {
  const base = process.env.LOCALAPPDATA ?? app.getPath('userData');
  return path.join(base, 'ControlDeUso', 'extension');
}
function versionIn(dir: string): string | null {
  try { return JSON.parse(readFileSync(path.join(dir, 'version.json'), 'utf8')).version ?? null; } catch { return null; }
}
/** Copia la extensión que trae esta versión de la app a su carpeta fija. La extensión se recarga sola al verla. */
function syncExtension(): void {
  const src = (TEST && process.env.CDU_EXTENSION_SRC) || path.join(process.resourcesPath, 'extension');
  const dst = extensionDir();
  const bundled = versionIn(src);
  if (!bundled || bundled === versionIn(dst)) return;
  try {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      if (name !== 'version.json') cpSync(path.join(src, name), path.join(dst, name), { recursive: true, force: true });
    }
    // version.json va el último: es la señal de que la copia está completa.
    writeFileSync(path.join(dst, 'version.json'), JSON.stringify({ version: bundled }));
  } catch (e) {
    console.warn('[control-de-uso] no se pudo copiar la extensión', e);
  }
}

// ------------------------------------------------------------------ ventanas

const preload = path.join(__dirname, 'preload.js');

let checkUpdatesNow: () => void = () => undefined;

function showPanel(): void {
  checkUpdatesNow();
  if (panel && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
    return;
  }
  panel = new BrowserWindow({
    width: 920, height: 760, minWidth: 640, minHeight: 520, title: 'Control de uso', backgroundColor: '#111827',
    icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('closed', () => { panel = null; });
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, backgroundColor: '#111827', title: 'Tiempo agotado',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void overlay.loadFile(path.join(__dirname, 'overlay.html'));
  return overlay;
}

/** Muestra el aviso a pantalla completa sobre la app bloqueada, sin quitarle el foco; o lo oculta. */
function setBlock(limit: Limit | null, state: State | null, fg: Foreground | null): void {
  if (!limit) {
    if (overlayKey) { overlayKey = ''; overlay?.hide(); }
    return;
  }
  let display = screen.getPrimaryDisplay();
  if (fg?.rect && fg.rect.width > 0) {
    const dip = process.platform === 'win32' ? screen.screenToDipRect(null, fg.rect) : fg.rect;
    display = screen.getDisplayMatching(dip);
  }
  const focused = !!state && inFocus(limit, state);
  const key = `${limit.id}|${display.id}|${fg?.exe}|${focused}|${!!limit.extra_available}`;
  if (key === overlayKey) return;
  overlayKey = key;
  const win = ensureOverlay();
  const data = focused
    ? {
      id: limit.id, title: `${limit.name} está en modo foco`,
      detail: `Lo bloqueaste tú hasta las ${fmtClock(state!.focus!.ends_at)}.`,
      resetsAt: null, extra: false,
    }
    : {
      id: limit.id, title: `Se acabó ${limit.name} por hoy`,
      detail: `Has gastado tu tiempo de hoy (${fmtDuration(limit.daily_seconds)}) entre todos tus dispositivos.`,
      resetsAt: state?.resets_at ?? null, extra: !!limit.extra_available,
    };
  const send = () => win.webContents.send('overlay', data);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
  win.setBounds(display.bounds);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
}

// ------------------------------------------------------------------ mensajes del panel

const ERRORS: Record<string, string> = {
  target_in_use: 'Esa web o app ya está en otro límite.',
  extra_already_used: 'El +5 de hoy ya está gastado.',
  extra_not_allowed: 'Este límite no permite el +5 ahora mismo.',
  focus_without_limits: 'Marca al menos un límite para el modo foco.',
  invalid_minutes: 'El foco dura entre 1 y 720 minutos.',
  limit_not_found: 'Ese límite ya no existe.',
  invalid_daily_seconds: 'Los minutos tienen que estar entre 0 y 1440.',
  'Invalid login credentials': 'Email o contraseña incorrectos.',
};

async function status(sb: SupabaseClient) {
  const { data } = await sb.auth.getSession();
  return {
    loggedIn: !!data.session,
    email: data.session?.user.email ?? null,
    device: engine.device,
    state: engine.state,
    remaining: engine.remaining(),
    version: app.getVersion(),
    foreground: engine.lastForeground,
    platformError,
    platform: 'windows' as const,
    extension: { dir: extensionDir(), version: versionIn(extensionDir()) },
  };
}

/**
 * Nombres e iconos de las apps de una lista. Los que falten y sean programas de este ordenador se
 * sacan del propio ejecutable y se suben, para que también se vean en el móvil y en el otro ordenador.
 */
async function appMeta(sb: SupabaseClient, top: { kind: string; value: string }[]): Promise<Record<string, { label?: string | null; icon?: string | null }>> {
  const keys = top.filter((t) => t.kind !== 'special').map((t) => ({ kind: t.kind, value: t.value }));
  if (top.some((t) => t.kind === 'special')) keys.push({ kind: 'domain', value: 'youtube.com' });
  if (keys.length === 0) return {};
  const { data } = await sb.rpc('get_app_meta', { p_keys: keys });
  const meta: Record<string, { label?: string | null; icon?: string | null }> = data ?? {};
  const missing: { kind: string; value: string; label: string; icon: string }[] = [];
  for (const k of keys) {
    const file = k.kind === 'win_process' ? loadDataPaths()[k.value] : undefined;
    if (!file || meta[`${k.kind}:${k.value}`]?.icon) continue;
    try {
      const icon = (await app.getFileIcon(file, { size: 'normal' })).toDataURL();
      if (!icon.startsWith('data:image/png;base64,') || icon.length > 40000) continue;
      const label = path.win32.basename(file).replace(/\.exe$/i, '');
      missing.push({ ...k, label, icon });
      meta[`${k.kind}:${k.value}`] = { label, icon };
    } catch {
      // Sin icono: el panel pondrá una inicial.
    }
  }
  if (missing.length) void sb.rpc('put_app_meta', { p_items: missing }).then(() => undefined, () => undefined);
  return meta;
}

function registerIpc(sb: SupabaseClient): void {
  const handle = async (msg: Record<string, any>) => {
    switch (msg.type) {
      case 'status': return status(sb);
      case 'refresh': await engine.refresh(); return status(sb);
      case 'login': {
        const device = String(msg.device ?? '').trim();
        if (!device) throw new Error('Pon un nombre a este dispositivo.');
        const { error } = await sb.auth.signInWithPassword({ email: String(msg.email).trim(), password: String(msg.password) });
        if (error) throw new Error(error.message);
        engine.setDevice(device);
        await engine.refresh();
        return status(sb);
      }
      case 'upsertLimit':
        await engine.call('upsert_limit', {
          p_id: msg.id, p_name: msg.name, p_daily_seconds: msg.dailySeconds, p_allow_extra: msg.allowExtra, p_targets: msg.targets,
        });
        return status(sb);
      case 'deleteLimit': await engine.call('delete_limit', { p_id: msg.id }); return status(sb);
      case 'cancelPending': await engine.call('cancel_pending', { p_id: msg.id }); return status(sb);
      case 'snoozeSuggestion': await engine.call('snooze_suggestion', { p_id: msg.id }); return status(sb);
      case 'grantExtra': await engine.call('grant_extra', { p_limit_id: msg.id, p_device: engine.device ?? '?' }); return status(sb);
      case 'startFocus': await engine.call('start_focus', { p_limit_ids: msg.ids, p_minutes: msg.minutes }); return status(sb);
      case 'exportCsv': {
        const { data, error } = await sb.rpc('export_usage_csv');
        if (error) throw new Error(error.message);
        const chosen = (TEST ? process.env.CDU_EXPORT_PATH : undefined)
          ?? (await dialog.showSaveDialog({ title: 'Exportar mis datos', defaultPath: 'control-de-uso.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })).filePath;
        if (!chosen) return { saved: false };
        // El BOM hace que Excel abra bien los acentos.
        writeFileSync(chosen, '\ufeff' + String(data), 'utf8');
        return { saved: true, path: chosen };
      }
      case 'listApps': return (await platform.listOpenApps()).map((a) => ({ id: a.exe, label: a.exe }));
      case 'stats': {
        const { data, error } = await sb.rpc('get_stats_range', {
          p_from: msg.from ?? null, p_to: msg.to ?? null, p_bucket: msg.bucket ?? null, p_device: msg.device ?? null,
          p_kind: msg.kind ?? null, p_value: msg.value ?? null,
        });
        if (error) throw new Error(error.message);
        return { ...data, meta: await appMeta(sb, data.top ?? []) };
      }
      case 'openExtensionDir': mkdirSync(extensionDir(), { recursive: true }); await shell.openPath(extensionDir()); return null;
      default: throw new Error('Mensaje desconocido');
    }
  };
  // Solo responden las dos páginas propias de la app (nunca una web, aunque alguna llegara a cargarse).
  const trusted = new Set(['panel.html', 'overlay.html'].map((f) => pathToFileURL(path.join(__dirname, f)).href));
  ipcMain.handle('cdu', async (event, msg) => {
    const from = event.senderFrame?.url.split(/[?#]/)[0] ?? '';
    if (!trusted.has(from) || !msg || typeof msg !== 'object') return { ok: false, error: 'Origen no permitido' };
    try {
      return { ok: true, result: await handle(msg) };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return { ok: false, error: ERRORS[text] ?? text };
    }
  });
}

// ------------------------------------------------------------------ actualizaciones

function setupUpdates(): void {
  if (!app.isPackaged) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (e) => console.warn('[control-de-uso] actualización', e.message));
  autoUpdater.on('update-downloaded', () => {
    engine.flushToDisk();
    autoUpdater.quitAndInstall(true, true);
  });
  let lastCheck = 0;
  const check = () => {
    lastCheck = Date.now();
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };
  setTimeout(check, 15_000);
  setInterval(check, 60 * 60 * 1000);
  // Abrir el panel también busca actualización (como mucho cada 10 minutos).
  checkUpdatesNow = () => { if (Date.now() - lastCheck > 10 * 60 * 1000) check(); };
}

// ------------------------------------------------------------------ arranque

// Las ventanas de la app nunca navegan fuera de sus propias páginas ni abren ventanas nuevas.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-redirect', (ev) => ev.preventDefault());
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('second-instance', () => showPanel());
app.on('window-all-closed', () => { /* la app sigue viva en la bandeja */ });

void app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  const sb = createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
    auth: { storageKey: 'sb-auth', storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const data = loadData();
  loadDataPaths = () => data.exePaths;
  engine = new Engine({
    sb, platform, data, save: saveData,
    ownExe: path.basename(process.execPath).toLowerCase(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    notify: (limitId, message) => {
      notices.get(limitId)?.close();
      const n = new Notification({ title: 'Control de uso', body: message });
      notices.set(limitId, n);
      n.show();
    },
    clearNotice: (limitId) => {
      const n = notices.get(limitId);
      if (!n) return;
      notices.delete(limitId);
      n.close();
    },
    onBlock: setBlock,
    onChange: () => { if (panel && !panel.isDestroyed()) panel.webContents.send('changed'); },
  });
  registerIpc(sb);
  syncExtension();

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Control de uso');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Abrir Control de uso', click: showPanel }]));
  tray.on('click', showPanel);

  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  engine.start();
  setupUpdates();
  if (!startHidden || !data.device) showPanel();
});

app.on('before-quit', () => engine?.flushToDisk());
