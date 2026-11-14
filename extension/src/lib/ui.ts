// Utilidades compartidas por las páginas de la extensión (popup, configuración y aviso de bloqueo).
import type { State } from './core.ts';

export interface Status {
  loggedIn: boolean;
  email: string | null;
  device: string | null;
  state: State | null;
  remaining: Record<string, number>;
  version: string;
}

export async function send(msg: Record<string, unknown>): Promise<Status> {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res) throw new Error('La extensión no responde. Recarga la página.');
  if (!res.ok) throw new Error(res.error);
  return res.result as Status;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta #${id}`);
  return el as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
