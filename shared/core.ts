// Lógica pura (sin APIs de Chrome) para poder probarla con Node.

export type Kind = 'domain' | 'win_process' | 'android_package' | 'special';
export interface Key { kind: Kind; value: string }
/** label: nombre legible de la app (lo sube el dispositivo que la tiene instalada), si se conoce. */
export interface Target extends Key { remove_on: string | null; label?: string | null }
export interface Limit {
  id: string;
  name: string;
  daily_seconds: number;
  used_seconds: number;
  remaining_seconds: number;
  allow_extra: boolean;
  /** Recién creado (menos de 10 minutos): aún se puede corregir libremente. */
  in_grace?: boolean;
  /** El +5 se puede pedir ahora mismo (permitido en este límite y aún no gastado hoy). */
  extra_available?: boolean;
  extra_from?: string | null;
  /** Propuesta de límite más bajo, si la media de 2 semanas queda claramente por debajo. */
  suggested_daily_seconds?: number | null;
  pending_daily_seconds: number | null;
  pending_delete: boolean;
  pending_effective: string | null;
  targets: Target[];
}
export interface Focus { ends_at: string; limit_ids: string[] }
export interface State { day: string; server_time: string; resets_at: string; limits: Limit[]; focus?: Focus | null; extra_used_today?: boolean }
export interface PendingEntry { kind: Kind; value: string; seconds: number; day: string; also?: Key[] }
export type Pending = Record<string, PendingEntry>;

export const SHORTS: Key = { kind: 'special', value: 'youtube_shorts' };

/** Día natural en Europe/Madrid, como 'YYYY-MM-DD'. */
export function madridDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Limpia lo que escriba el usuario ('https://www.Instagram.com/reels') y devuelve 'instagram.com', o null. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

/** Identificadores de una URL: el dominio y, si es un Short de YouTube, también el identificador de Shorts. */
export function keysFor(url: string): Key[] | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const keys: Key[] = [{ kind: 'domain', value: host }];
  if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && u.pathname.startsWith('/shorts/')) {
    keys.push(SHORTS);
  }
  return keys;
}

/** Misma regla que _target_matches en la base de datos: un dominio cubre sus subdominios. */
export function targetMatches(t: Key, k: Key): boolean {
  if (t.kind !== k.kind) return false;
  if (t.value === k.value) return true;
  return t.kind === 'domain' && k.value.endsWith('.' + t.value);
}

export function limitMatches(limit: Limit, keys: Key[]): boolean {
  return limit.targets.some((t) => keys.some((k) => targetMatches(t, k)));
}

export function sameKeys(a: Key[] | null | undefined, b: Key[] | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((k, i) => k.kind === b[i].kind && k.value === b[i].value);
}

/** Acumula segundos aún no enviados al servidor. */
export function addPending(pending: Pending, keys: Key[], seconds: number, day: string): void {
  if (seconds <= 0 || keys.length === 0) return;
  const [main, ...also] = keys;
  const id = [day, ...keys.map((k) => `${k.kind}:${k.value}`)].join('|');
  const cur = pending[id];
  if (cur) cur.seconds += seconds;
  else pending[id] = { kind: main.kind, value: main.value, seconds, day, ...(also.length ? { also } : {}) };
}

/** ¿Está este límite bloqueado ahora mismo por el modo foco? */
export function inFocus(limit: Limit, state: State, now: number = Date.now()): boolean {
  const f = state.focus;
  return !!f && f.limit_ids.includes(limit.id) && new Date(f.ends_at).getTime() > now;
}

/**
 * Segundos que le quedan hoy a un límite: lo que dice el servidor menos lo local aún sin enviar.
 * Con el modo foco activo sobre él, cero.
 */
export function effectiveRemaining(limit: Limit, state: State, pending: Pending, today: string, now: number = Date.now()): number {
  if (inFocus(limit, state, now)) return 0;
  let remaining = state.day === today ? limit.remaining_seconds : limit.daily_seconds;
  for (const e of Object.values(pending)) {
    if (e.day !== today) continue;
    const keys: Key[] = [{ kind: e.kind, value: e.value }, ...(e.also ?? [])];
    if (limitMatches(limit, keys)) remaining -= e.seconds;
  }
  return Math.max(remaining, 0);
}

/** Cuántos segundos contar de un intervalo abierto. Si el hueco es raro (equipo suspendido), no se cuenta. */
export function creditedSeconds(elapsedMs: number): number {
  const secs = Math.floor(elapsedMs / 1000);
  if (secs <= 0) return 0;
  if (secs > 120) return 0;
  return Math.min(secs, 60);
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return sec ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}
