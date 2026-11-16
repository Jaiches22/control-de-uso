// Motor: cada segundo mira la app en primer plano, acumula su tiempo, lo sincroniza con Supabase
// y avisa cuando un límite se agota.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import {
  addPending, creditedSeconds, effectiveRemaining, fmtDuration, limitMatches, madridDay, sameKeys,
  type Key, type Limit, type Pending, type PendingEntry, type State,
} from '../../../shared/core.ts';
import type { Foreground, Platform } from './platform.ts';
import type { LocalData } from './store.ts';

const IDLE_SECONDS = 120;
const FLUSH_EVERY_MS = 28_000;
const IDLE_REFRESH_MS = 120_000;
const RETRY_GAP_MS = 3_000;
const OWN_ECHO_MS = 1_500;
const RPC_TIMEOUT_MS = 10_000;

// Brave lo cuenta la extensión. El resto son piezas del propio Windows que no son "usar una app".
const NOT_COUNTED = new Set([
  'brave.exe', 'lockapp.exe', 'logonui.exe', 'searchhost.exe', 'searchapp.exe', 'shellexperiencehost.exe',
  'startmenuexperiencehost.exe', 'textinputhost.exe', 'dwm.exe', 'consent.exe',
]);

export interface EngineDeps {
  sb: SupabaseClient;
  platform: Platform;
  data: LocalData;
  save: (d: LocalData) => void;
  ownExe: string;
  idleSeconds: () => number;
  notify: (message: string) => void;
  /** limit = null significa "quita el aviso de bloqueo". */
  onBlock: (limit: Limit | null, state: State | null, fg: Foreground | null) => void;
  onChange: () => void;
}

export class Engine {
  state: State | null = null;
  lastForeground: string | null = null;
  private cur: { keys: Key[]; since: number } | null = null;
  private lastFlushAt = 0;
  private lastAttemptAt = 0;
  private syncing = false;
  private refreshWanted = true;
  private polls = 0;
  private channel: RealtimeChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: EngineDeps) {}

  get device(): string | null { return this.d.data.device; }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.poll(), 1000);
    void this.ensureRealtime();
  }

  setDevice(device: string): void {
    this.d.data.device = device;
    this.d.save(this.d.data);
    this.refreshWanted = true;
    void this.ensureRealtime();
  }

  async hasSession(): Promise<boolean> {
    return !!(await this.d.sb.auth.getSession()).data.session;
  }

  private async ensureRealtime(): Promise<void> {
    if (this.channel || !(await this.hasSession())) return;
    const ch = this.d.sb.channel('cambios');
    for (const table of ['limit_usage', 'limits', 'limit_targets', 'extra_grants', 'focus_sessions']) {
      ch.on('postgres_changes' as never, { event: '*', schema: 'public', table } as never, () => {
        if (Date.now() - this.lastFlushAt > OWN_ECHO_MS) this.refreshWanted = true;
      });
    }
    ch.subscribe();
    this.channel = ch;
  }

  remaining(): Record<string, number> {
    const today = madridDay(new Date());
    const out: Record<string, number> = {};
    for (const l of this.state?.limits ?? []) out[l.id] = effectiveRemaining(l, this.state!, this.d.data.pending, today);
    return out;
  }

  /** Aplica el estado devuelto por una función de configuración (crear, editar o borrar límites). */
  async call(name: string, args: Record<string, unknown>): Promise<void> {
    this.state = await this.rpc(name, args);
    this.d.onChange();
  }

  async refresh(): Promise<void> {
    this.refreshWanted = true;
    await this.sync();
  }

  private async rpc(name: string, args?: Record<string, unknown>): Promise<State> {
    const { data, error } = await this.d.sb.rpc(name, args).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return data as State;
  }

  private poll(): void {
    const { data } = this.d;
    if (!data.device) return;
    const now = Date.now();
    const today = madridDay(new Date(now));
    if (data.warned.day !== today) data.warned = { day: today, ids: [] };

    let fg: Foreground | null = null;
    try { fg = this.d.platform.foreground(); } catch (e) { console.warn('[control-de-uso] primer plano', e); }
    this.lastForeground = fg?.exe ?? null;
    if (fg?.path && data.exePaths[fg.exe] !== fg.path) data.exePaths[fg.exe] = fg.path;
    const idle = this.d.idleSeconds() >= IDLE_SECONDS;
    let keys: Key[] | null =
      fg && !idle && !NOT_COUNTED.has(fg.exe) && fg.exe !== this.d.ownExe ? [{ kind: 'win_process', value: fg.exe }] : null;

    // 1. Cerrar el intervalo abierto.
    if (this.cur) {
      const elapsed = now - this.cur.since;
      if (elapsed >= 1000) {
        const secs = creditedSeconds(elapsed);
        addPending(data.pending, this.cur.keys, secs, today);
        this.cur.since = secs > 0 && elapsed < 61_000 ? this.cur.since + secs * 1000 : now;
      }
    }

    // 2. Aplicar límites a la app en primer plano (aunque esté inactivo: el aviso no se quita solo).
    let blocked: Limit | null = null;
    const fgKeys: Key[] | null = fg && fg.exe !== this.d.ownExe ? [{ kind: 'win_process', value: fg.exe }] : null;
    if (fgKeys && this.state) {
      for (const limit of this.state.limits.filter((l) => limitMatches(l, fgKeys))) {
        const left = effectiveRemaining(limit, this.state, data.pending, today);
        if (left <= 0) { blocked = blocked ?? limit; continue; }
        if (left <= 60 && !data.warned.ids.includes(limit.id)) {
          data.warned.ids.push(limit.id);
          this.d.notify(`Te queda ${fmtDuration(left)} de ${limit.name} por hoy.`);
        }
      }
    }
    if (blocked) keys = null;
    this.d.onBlock(blocked, this.state, fg);

    // 3. Abrir el intervalo nuevo.
    this.cur = keys ? { keys, since: this.cur && sameKeys(this.cur.keys, keys) ? this.cur.since : now } : null;

    // 4. Sincronizar cuando toca.
    const hasPending = Object.keys(data.pending).length > 0;
    const stale = !this.state || this.state.day !== today;
    const due = this.refreshWanted || stale
      || (hasPending && (now - this.lastFlushAt > FLUSH_EVERY_MS || (blocked !== null)))
      || now - this.lastFlushAt > IDLE_REFRESH_MS;
    if (due && (this.refreshWanted || now - this.lastAttemptAt > RETRY_GAP_MS)) void this.sync();

    if (++this.polls % 10 === 0) this.d.save(data);
  }

  /** Envía lo pendiente (o pide el estado). Lo que se acumule mientras tanto se conserva. */
  private async sync(): Promise<void> {
    if (this.syncing || !this.d.data.device) return;
    this.syncing = true;
    this.refreshWanted = false;
    this.lastAttemptAt = Date.now();
    const pending = this.d.data.pending;
    const sent: Record<string, PendingEntry> = structuredClone(pending);
    try {
      const entries = Object.values(sent);
      this.state = entries.length
        ? await this.rpc('add_usage', { p_device: this.d.data.device, p_entries: entries })
        : await this.rpc('get_state');
      for (const [id, e] of Object.entries(sent)) {
        const cur = pending[id];
        if (!cur) continue;
        cur.seconds -= e.seconds;
        if (cur.seconds <= 0) delete pending[id];
      }
      this.lastFlushAt = Date.now();
      this.d.save(this.d.data);
      this.d.onChange();
    } catch (e) {
      console.warn('[control-de-uso] sin sincronizar', e instanceof Error ? e.message : e);
    } finally {
      this.syncing = false;
    }
  }

  flushToDisk(): void { this.d.save(this.d.data); }
}
