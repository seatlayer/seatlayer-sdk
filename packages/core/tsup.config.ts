import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // konva is a runtime dependency — keep it external so consumers dedupe one copy.
  external: ['konva'],
  // The synced engine has one Vite-only dev hook. Compile it out for the published
  // build so there's no `import.meta.env` at runtime (undefined in a plain bundle).
  define: {
    'import.meta.env.DEV': 'false',
  },
});
