// Compila el panel web que la app de Android muestra en un WebView y lo deja en los assets del APK.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const out = '../app/src/main/assets/app';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('panel.html', `${out}/panel.html`);
await cp('../../shared/style.css', `${out}/style.css`);
await build({ entryPoints: ['panel.ts'], outdir: out, bundle: true, platform: 'browser', format: 'iife', target: 'chrome110' });
console.log('Panel de Android compilado');
