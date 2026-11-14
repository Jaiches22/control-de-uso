import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cdu', {
  platform: 'windows',
  send: (msg: Record<string, unknown>) => ipcRenderer.invoke('cdu', msg),
  onChange: (cb: () => void) => { ipcRenderer.on('changed', () => cb()); },
  onOverlay: (cb: (data: unknown) => void) => { ipcRenderer.on('overlay', (_e, data) => cb(data)); },
});
