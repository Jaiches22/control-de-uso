// Datos locales de la app: nombre del dispositivo, uso pendiente de enviar y sesión (cifrada por Windows).
import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Pending } from '../../../shared/core.ts';

export interface LocalData {
  device: string | null;
  pending: Pending;
  warned: { day: string; ids: string[] };
}

const dir = () => app.getPath('userData');
const dataFile = () => path.join(dir(), 'data.json');
const authFile = () => path.join(dir(), 'session.bin');

function writeAtomic(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function loadData(): LocalData {
  try {
    const d = JSON.parse(readFileSync(dataFile(), 'utf8')) as Partial<LocalData>;
    return { device: d.device ?? null, pending: d.pending ?? {}, warned: d.warned ?? { day: '', ids: [] } };
  } catch {
    return { device: null, pending: {}, warned: { day: '', ids: [] } };
  }
}

export function saveData(d: LocalData): void {
  try { writeAtomic(dataFile(), JSON.stringify(d)); } catch (e) { console.warn('[control-de-uso] no se pudo guardar', e); }
}

/** Almacén de sesión para supabase-js. Los tokens se guardan cifrados con la cuenta de Windows del usuario. */
function readAuth(): Record<string, string> {
  try {
    const raw = readFileSync(authFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function writeAuth(all: Record<string, string>): void {
  try {
    if (Object.keys(all).length === 0) return rmSync(authFile(), { force: true });
    const text = JSON.stringify(all);
    writeAtomic(authFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text);
  } catch (e) {
    console.warn('[control-de-uso] no se pudo guardar la sesión', e);
  }
}
export const authStorage = {
  getItem: (k: string) => readAuth()[k] ?? null,
  setItem: (k: string, v: string) => { const all = readAuth(); all[k] = v; writeAuth(all); },
  removeItem: (k: string) => { const all = readAuth(); delete all[k]; writeAuth(all); },
};
