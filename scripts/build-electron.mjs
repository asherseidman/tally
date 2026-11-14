// Bundles the Electron main process (ESM) with esbuild; every bare import stays external and loads from node_modules.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist-electron', { recursive: true });
await build({
  entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.mjs', bundle: true, platform: 'node', format: 'esm',
  target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info',
});
copyFileSync('electron/preload.cjs', 'dist-electron/preload.cjs');
