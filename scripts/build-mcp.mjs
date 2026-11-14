// Bundles the MCP connector to dist-mcp/tally-mcp.mjs (one file; node_modules stays external, so it runs from this folder with plain `node`).
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist-mcp', { recursive: true });
await build({
  entryPoints: ['src/mcp/main.ts'], outfile: 'dist-mcp/tally-mcp.mjs', bundle: true, platform: 'node', format: 'esm',
  target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info',
});
