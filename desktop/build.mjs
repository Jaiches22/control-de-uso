// Compila la app de escritorio en dist/. La URL y la clave pública de Supabase llegan por variables de entorno.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Faltan SUPABASE_URL o SUPABASE_ANON_KEY');
  process.exit(1);
}
const define = { __SUPABASE_URL__: JSON.stringify(url), __SUPABASE_KEY__: JSON.stringify(key) };

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('static', 'dist', { recursive: true });
await cp('../shared/style.css', 'dist/style.css');

await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  outdir: 'dist', bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron', 'koffi'], define,
});
await build({
  entryPoints: ['src/renderer/panel.ts', 'src/renderer/overlay.ts'],
  outdir: 'dist', bundle: true, platform: 'browser', format: 'iife', target: 'chrome130',
});
console.log('App de escritorio compilada');
