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
    // CDN bundles can't code-split, so the widget loads the lazy 3D chunk
    // (seatlayer-view3d.mjs, built by cdn/vite.view3d.config.ts) at 3D-open time
    // by absolute URL. This flag routes SeatPicker to that path; the bare
    // `import('@seatlayer/core/view3d')` fallback is externalized below so it is
    // never inlined into the IIFE (it is dead at runtime here anyway).
    __SEATLAYER_CDN__: 'true',
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
      // The lazy 3D chunk is loaded at runtime by URL (see the define above), so
      // its bare-specifier fallback import must stay OUT of the IIFE/ESM bundle.
      external: ['@seatlayer/core/view3d'],
      // Expected: the widget reads `import.meta.url` for the ESM (.mjs) 3D-chunk
      // base; in the IIFE (.js) output that folds to `{}` and we fall back to
      // `document.currentScript.src` instead, so this warning is by design.
      onwarn(warning, defaultHandler) {
        if (warning.code === 'EMPTY_IMPORT_META') return;
        defaultHandler(warning);
      },
      output: {
        codeSplitting: false,
        footer:
          "if (typeof window !== 'undefined' && window.seatlayer) { window.seatmap = window.seatmap || window.seatlayer; }",
      },
    },
  },
});
