import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import jsPackage from '../packages/js/package.json';

const version = jsPackage.version;
// Canonical CDN namespace: /seatlayer-js@<x.y.z>/seatlayer.js. The filename is
// constant across versions so upgrading is a one-token edit. See cdn/src/worker.mjs.
const releaseDir = resolve(__dirname, `dist/seatlayer-js@${version}`);

export default defineConfig({
  define: {
    __SEATLAYER_SDK_VERSION__: JSON.stringify(version),
  },
  resolve: {
    // Bundle the exact core source used by the npm workspace, not a second CDN
    // implementation or a separately versioned copy.
    alias: {
      '@seatlayer/core': resolve(__dirname, '../packages/core/src/index.ts'),
    },
  },
  build: {
    target: 'es2019',
    outDir: releaseDir,
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'seatlayer',
      formats: ['iife', 'es'],
      fileName: (format) => `seatlayer.${format === 'es' ? 'mjs' : 'js'}`,
    },
    rollupOptions: {
      output: {
        codeSplitting: false,
        footer:
          "if (typeof window !== 'undefined' && window.seatlayer) { window.seatmap = window.seatmap || window.seatlayer; }",
      },
    },
  },
});
