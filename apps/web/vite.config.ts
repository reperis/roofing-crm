import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: {
    // Stamped at build time. Evaluating `new Date()` in the bundle would report when the page was
    // opened, not when the deployed artifact was produced — which is the question a reader of a
    // deployed build actually has.
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // DuckDB-WASM ships large worker bundles; the default 500 kB warning is pure noise here.
    chunkSizeWarningLimit: 4096,
  },
  // No `worker.format` override. Forcing ES-module workers breaks MapLibre, whose tile worker is
  // classic — the map then mounts, sizes itself and handles clicks perfectly while rendering
  // nothing at all, because tile parsing happens in that worker. DuckDB is unaffected either way:
  // its worker is constructed from a URL with an explicit `{ type: 'module' }`, which this setting
  // does not govern.
});
