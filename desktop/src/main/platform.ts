// Lo que depende del sistema operativo: qué app está en primer plano y qué apps hay abiertas.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Foreground { exe: string; rect: Rect | null; path?: string }
export interface OpenApp { exe: string; title: string }
export interface Platform {
  foreground(): Foreground | null;
  listOpenApps(): Promise<OpenApp[]>;
}

/** Windows: llamadas directas a user32/kernel32 mediante koffi. */
function createWindows(): Platform {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* pid)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void* hWnd, _Out_ RECT* rect)');
  const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
  const QueryFullProcessImageNameW = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 flags, _Out_ uint16* name, _Inout_ uint32* size)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void* handle)');
  void RECT;
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const names = new Map<number, { exe: string; path: string }>(); // pid -> ejecutable (caché pequeña)

  function exeOf(pid: number): { exe: string; path: string } | null {
    const cached = names.get(pid);
    if (cached) return cached;
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!handle) return null;
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return null;
      const full = String.fromCharCode(...buf.subarray(0, size[0]));
      const found = { exe: path.win32.basename(full).toLowerCase(), path: full };
      if (names.size > 500) names.clear();
      names.set(pid, found);
      return found;
    } finally {
      CloseHandle(handle);
    }
  }

  return {
    foreground() {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      if (!pid[0]) return null;
      const found = exeOf(pid[0]);
      if (!found) return null;
      const r: { left?: number; top?: number; right?: number; bottom?: number } = {};
      const rect = GetWindowRect(hwnd, r) && r.right !== undefined
        ? { x: r.left!, y: r.top!, width: r.right! - r.left!, height: r.bottom! - r.top! }
        : null;
      return { exe: found.exe, rect, path: found.path };
    },
    listOpenApps() {
      // tasklist /v incluye el título de la ventana principal de cada proceso.
      return new Promise((resolve, reject) => {
        execFile('tasklist', ['/v', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => {
            if (err) return reject(new Error('No he podido listar las apps abiertas.'));
            resolve(parseTasklist(stdout.toString('latin1')));
          });
      });
    },
  };
}

const NO_TITLE = new Set(['', 'n/a', 'n/d', 'n/v', 'n. v.', 's/o', 'nd', 'non disponibile']);
const HIDDEN = new Set(['textinputhost.exe', 'applicationframehost.exe', 'systemsettings.exe', 'tasklist.exe', 'control de uso.exe']);

export function parseTasklist(csv: string): OpenApp[] {
  const apps = new Map<string, OpenApp>();
  for (const line of csv.split(/\r?\n/)) {
    const cols = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (cols.length < 9) continue;
    const exe = cols[0].toLowerCase();
    const title = cols[cols.length - 1].trim();
    if (!exe.endsWith('.exe') || NO_TITLE.has(title.toLowerCase()) || HIDDEN.has(exe)) continue;
    if (!apps.has(exe)) apps.set(exe, { exe, title });
  }
  return [...apps.values()].sort((a, b) => a.exe.localeCompare(b.exe));
}

/** Pruebas: la "app en primer plano" se lee de un archivo JSON ({ "exe": "...", "apps": [...] }). */
function createFake(file: string): Platform {
  const read = (): { exe?: string | null; apps?: OpenApp[] } => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  };
  return {
    foreground: () => { const f = read(); return f.exe ? { exe: f.exe.toLowerCase(), rect: null } : null; },
    listOpenApps: async () => read().apps ?? [],
  };
}

/** Si las llamadas a Windows no cargan, la app sigue funcionando (panel, límites) y lo cuenta en el panel. */
export let platformError: string | null = null;

export function createPlatform(allowTestHooks: boolean): Platform {
  if (allowTestHooks && process.env.CDU_FAKE_FOREGROUND) return createFake(process.env.CDU_FAKE_FOREGROUND);
  if (process.platform === 'win32') {
    try {
      return createWindows();
    } catch (e) {
      platformError = e instanceof Error ? e.message : String(e);
    }
  }
  return { foreground: () => null, listOpenApps: async () => [] };
}
