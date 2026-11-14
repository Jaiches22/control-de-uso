// Puente con la parte nativa: define el objeto global `cdu` que usa el panel compartido.
declare const Android: { send: (id: number, json: string) => void };

type Reply = { ok: boolean; result?: unknown; error?: string };
const waiting = new Map<number, (r: Reply) => void>();
let seq = 0;
let onChange: (() => void) | null = null;

const w = window as unknown as Record<string, unknown>;
w.__cduReply = (id: number, json: string) => {
  const done = waiting.get(id);
  waiting.delete(id);
  done?.(JSON.parse(json) as Reply);
};
w.__cduChanged = () => onChange?.();
w.cdu = {
  platform: 'android',
  send: (msg: Record<string, unknown>) => new Promise<Reply>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    Android.send(id, JSON.stringify(msg));
  }),
  onChange: (cb: () => void) => { onChange = cb; },
};
