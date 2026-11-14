// Proceso principal: bandeja, panel, aviso de bloqueo, carpeta de la extensión y actualizaciones.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from 'electron';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fmtDuration, type Limit, type State } from '../../../shared/core.ts';
import { Engine } from './engine.ts';
import { createPlatform, platformError, type Foreground } from './platform.ts';
import { authStorage, loadData, saveData } from './store.ts';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

const APP_ID = 'es.jaimecalzada.controldeuso';
const startHidden = process.argv.includes('--hidden');

if (process.env.CDU_USER_DATA) app.setPath('userData', process.env.CDU_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let overlayKey = '';
let engine: Engine;
const platform = createPlatform();

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
  const src = process.env.CDU_EXTENSION_SRC ?? path.join(process.resourcesPath, 'extension');
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

function showPanel(): void {
  if (panel && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
    return;
  }
  panel = new BrowserWindow({
    width: 920, height: 760, minWidth: 640, minHeight: 520, title: 'Control de uso', backgroundColor: '#111827',
    icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  void panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('closed', () => { panel = null; });
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, backgroundColor: '#111827', title: 'Tiempo agotado',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
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
  const key = `${limit.id}|${display.id}|${fg?.exe}`;
  if (key === overlayKey) return;
  overlayKey = key;
  const win = ensureOverlay();
  const data = {
    name: limit.name,
    detail: `Has gastado tus ${fmtDuration(limit.daily_seconds)} de hoy entre todos tus dispositivos.`,
    resetsAt: state?.resets_at ?? null,
    app: fg?.exe ?? '',
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
      case 'listApps': return (await platform.listOpenApps()).map((a) => ({ id: a.exe, label: a.exe }));
      case 'stats': {
        const { data, error } = await sb.rpc('get_stats', {
          p_bucket: msg.bucket, p_count: msg.count, p_kind: msg.kind ?? null, p_value: msg.value ?? null,
        });
        if (error) throw new Error(error.message);
        return data;
      }
      case 'openExtensionDir': mkdirSync(extensionDir(), { recursive: true }); await shell.openPath(extensionDir()); return null;
      default: throw new Error('Mensaje desconocido');
    }
  };
  ipcMain.handle('cdu', async (_e, msg) => {
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
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 15_000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

// ------------------------------------------------------------------ arranque

app.on('second-instance', () => showPanel());
app.on('window-all-closed', () => { /* la app sigue viva en la bandeja */ });

void app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  const sb = createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
    auth: { storageKey: 'sb-auth', storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const data = loadData();
  engine = new Engine({
    sb, platform, data, save: saveData,
    ownExe: path.basename(process.execPath).toLowerCase(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    notify: (message) => new Notification({ title: 'Control de uso', body: message }).show(),
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
