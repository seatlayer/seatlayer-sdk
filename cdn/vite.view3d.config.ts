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

// The scene worker (packages/core/src/view3d/scene/scene.worker.ts) is reached
// through `new Worker(new URL('./scene/scene.worker.ts', import.meta.url),
// { type: 'module' })`, so Vite emits it as a HASHED asset beside the chunk and
// rewrites that URL. With the default `base: '/'` the rewrite is root-absolute
// (`/assets/scene.worker-<hash>.js`), which on the CDN resolves to
// cdn.seatlayer.io/assets/… — outside the pinned version directory, where nothing
// is ever published, so the worker 404s and prepareVenue3D silently falls back to
// the main thread. `base: './'` makes it relative to the importing chunk, so it
// resolves to /seatlayer-js@<x.y.z>/assets/scene.worker-<hash>.js — the key
// upload-cdn.mjs writes and cdn/src/worker.mjs serves.
export default defineConfig({
  base: './',
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
