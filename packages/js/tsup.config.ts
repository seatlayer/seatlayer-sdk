import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // core + konva stay external so the whole SDK shares one engine + one konva.
  external: ['@seatlayer/core', 'konva'],
});
