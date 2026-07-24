import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/index.ts` is the main engine export; `src/view3d/index.ts` is a SEPARATE
  // entry so the lazy OGL venue-view chunk (`@seatlayer/core/view3d`) is never
  // pulled into the main engine bundle — importing it stays opt-in and GL-free
  // until a consumer dynamically imports the subpath.
  entry: ['src/index.ts', 'src/view3d/index.ts'],
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
