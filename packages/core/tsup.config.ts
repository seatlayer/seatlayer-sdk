import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/index.ts` is the main engine export; `src/view3d/index.ts` is a SEPARATE
  // entry so the lazy OGL venue-view chunk (`@seatlayer/core/view3d`) is never
  // pulled into the main engine bundle — importing it stays opt-in and GL-free
  // until a consumer dynamically imports the subpath.
  // The last two are DEEP subpaths (`@seatlayer/core/view/panoramaDelivery`,
  // `@seatlayer/core/view3d/crossfade/panorama`). They exist because the buyer
  // widget imports those two engine modules by their path inside the mirrored
  // `src/` tree rather than through a barrel — the app's vendored copy resolves
  // the same modules as `../../view/…` / `../../view3d/…`, and sync-widget's
  // rewrite turns one form into the other. Both are pure (no module state, no
  // GL), so being reachable from two entries costs a shared chunk and nothing
  // else. Their paths under dist/ mirror src/, which is what makes the subpath
  // specifier and the app's relative specifier line up character for character.
  entry: [
    'src/index.ts',
    'src/view3d/index.ts',
    'src/view/panoramaDelivery.ts',
    'src/view3d/crossfade/panorama.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // konva + ogl + earcut are runtime dependencies — keep them external so
  // consumers dedupe one copy each (ogl + earcut are only reached through the
  // view3d subpath entry).
  external: ['konva', 'ogl', 'earcut'],
  // The synced engine has one Vite-only dev hook. Compile it out for the published
  // build so there's no `import.meta.env` at runtime (undefined in a plain bundle).
  define: {
    'import.meta.env.DEV': 'false',
  },
});
