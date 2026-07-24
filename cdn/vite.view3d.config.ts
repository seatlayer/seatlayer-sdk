import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import jsPackage from '../packages/js/package.json';

// The lazy 3D venue-view chunk, built as a SELF-CONTAINED ESM asset that lives
// beside the pinned CDN bundle:
//
//   cdn/dist/seatlayer-js@<x.y.z>/seatlayer-view3d.mjs
//
// The IIFE/ESM widget (built by cdn/vite.config.ts) loads it at 3D-open time via
// `import(new URL('./seatlayer-view3d.mjs', import.meta.url))`. Because CDN
// bundles can't code-split, this is a separate build; ogl + earcut are bundled
// IN (not external) so the asset is standalone. Run AFTER the main build with
// `emptyOutDir: false` so it drops alongside seatlayer.js/.mjs without wiping
// them. finalize-cdn.mjs records it in release.json; upload-cdn.mjs ships it.
const version = jsPackage.version;
const releaseDir = resolve(__dirname, `dist/seatlayer-js@${version}`);

export default defineConfig({
  build: {
    target: 'es2019',
    outDir: releaseDir,
    emptyOutDir: false,
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, '../packages/core/src/view3d/index.ts'),
      formats: ['es'],
      fileName: () => 'seatlayer-view3d.mjs',
    },
  },
});
