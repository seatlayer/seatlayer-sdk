import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import jsPackage from '../packages/js/package.json';
import { minifyCssLiterals } from './minifyCssLiterals';

// The lazy hosted-checkout chunk, built as a SELF-CONTAINED ESM asset beside the
// pinned CDN bundle:
//
//   cdn/dist/seatlayer-js@<x.y.z>/seatlayer-checkout.mjs
//
// It holds the card that collects a buyer's email, starts a payment against the
// organizer's own gateway and waits for the webhook — everything `SeatPicker`'s
// `checkout: 'hosted'` adds. Payment code is the clearest case there is for
// splitting: `checkout` defaults to `'handoff'`, so for most integrations these
// bytes are unreachable, and even where hosted checkout IS on, the overwhelming
// majority of sessions look at a seat map and never press Pay. The widget loads
// it by URL at that press, and not one byte earlier.
//
// Its own asset rather than a fold into either existing chunk: seatlayer-view3d
// is 74 KB gzipped of GL that a checkout has no use for, and seatlayer-panorama
// is fetched by a completely different gesture. Small chunks, each fetched by
// the gesture that needs it.
//
// The CSS-literal minifier is here for the same reason it is on the main build:
// the card's stylesheet ships inside a template literal, which esbuild's JS
// minifier cannot see into, so its comments and indentation would go over the
// wire verbatim.
//
// Run AFTER the main build with `emptyOutDir: false` so it drops alongside
// seatlayer.js/.mjs without wiping them. finalize-cdn.mjs records it in
// release.json; upload-cdn.mjs ships it; the Worker allowlist serves it.
const version = jsPackage.version;
const releaseDir = resolve(__dirname, `dist/seatlayer-js@${version}`);

export default defineConfig({
  plugins: [minifyCssLiterals()],
  build: {
    target: 'es2019',
    outDir: releaseDir,
    emptyOutDir: false,
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/checkout.ts'),
      formats: ['es'],
      fileName: () => 'seatlayer-checkout.mjs',
    },
  },
});
