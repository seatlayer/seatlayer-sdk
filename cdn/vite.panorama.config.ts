import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import jsPackage from '../packages/js/package.json';

// The lazy view-from-seat chunk, built as a SELF-CONTAINED ESM asset beside the
// pinned CDN bundle:
//
//   cdn/dist/seatlayer-js@<x.y.z>/seatlayer-panorama.mjs
//
// `generateSeatPanorama` draws a 2048x1024 equirectangular texture of the hall
// from one seat's eye position. It is ~25 KB of drawing code that only runs when
// a buyer taps "View from here" — most sessions never do — so it sits out of the
// main bundle and the widget imports it by URL at that tap.
//
// A SEPARATE asset rather than a fold into seatlayer-view3d.mjs, even though 3D
// also asks for panoramas. The 2D "View from here" button does not enter 3D and
// never loads the GL chunk; folding would make that tap pull 281 KB of OGL scene
// code (74 KB gzipped) to draw a 2D canvas — code a device without WebGL2 cannot
// even run — in exchange for saving 6.4 KB on first load. Two small chunks, each
// fetched by the gesture that needs it.
//
// Run AFTER the main build with `emptyOutDir: false` so it drops alongside
// seatlayer.js/.mjs without wiping them. finalize-cdn.mjs records it in
// release.json; upload-cdn.mjs ships it; the Worker allowlist serves it.
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
      entry: resolve(__dirname, 'src/panorama.ts'),
      formats: ['es'],
      fileName: () => 'seatlayer-panorama.mjs',
    },
  },
});
