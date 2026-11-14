// npm run dev: Vite dev server for the renderer + the Electron main process pointed at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const server = await createServer({ configFile: 'renderer/vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
await import('./build-electron.mjs');
const extra = process.argv.slice(2);
const child = spawn(require('electron'), ['.', ...extra], { stdio: 'inherit', env: { ...process.env, ELECTRON_RENDERER_URL: url } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
