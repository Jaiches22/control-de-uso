// Compila la extensión en dist/. La URL y la clave pública de Supabase llegan por variables de entorno
// (en GitHub Actions, desde los secretos del repositorio).
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Faltan SUPABASE_URL o SUPABASE_ANON_KEY');
  process.exit(1);
}
const version = (process.env.VERSION || '0.0.0').replace(/^v/, '');

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('static', 'dist', { recursive: true });
await cp('../shared/style.css', 'dist/style.css');

const manifest = JSON.parse(await readFile('static/manifest.json', 'utf8'));
manifest.version = version;
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
await writeFile('dist/version.json', JSON.stringify({ version }));

await build({
  entryPoints: ['src/background.ts', 'src/popup.ts', 'src/options.ts', 'src/blocked.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: false,
  define: {
    __SUPABASE_URL__: JSON.stringify(url),
    __SUPABASE_KEY__: JSON.stringify(key),
  },
});
console.log('Extensión compilada, versión', version);
