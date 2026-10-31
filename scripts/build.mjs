// Builds the app into www/ (used by both the Android app and the web version).
//   * bundles src/js/app.js (+ Leaflet, Capacitor, Supabase) with esbuild
//   * copies static files
//   * injects Supabase settings from environment variables or a local .env file
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const env = { ...readDotEnv('.env'), ...process.env };
const config = {
  SUPABASE_URL: env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || '',
  WEB_URL: env.WALKER_WEB_URL || 'https://kaddakaman.github.io/Walker/',
};

rmSync('www', { recursive: true, force: true });
mkdirSync('www/vendor', { recursive: true });
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'icons']) {
  cpSync(`src/${f}`, `www/${f}`, { recursive: true });
}
cpSync('node_modules/leaflet/dist/leaflet.css', 'www/vendor/leaflet.css');

await build({
  entryPoints: ['src/js/app.js'],
  bundle: true,
  format: 'esm',
  target: ['es2020', 'chrome89'],
  minify: true,
  sourcemap: true,
  outfile: 'www/js/app.js',
  define: { __WALKER_CONFIG__: JSON.stringify(config) },
  logLevel: 'info',
});

console.log(
  config.SUPABASE_URL
    ? `Accounts enabled (${config.SUPABASE_URL})`
    : 'Accounts disabled: SUPABASE_URL / SUPABASE_ANON_KEY not set (see README)'
);

function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
