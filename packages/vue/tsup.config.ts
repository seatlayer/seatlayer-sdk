import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/manager.ts` is a SEPARATE entry: the control room without the buyer
  // components. See src/manager.ts.
  entry: ['src/index.ts', 'src/manager.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // `@seatlayer/js/manager` stays external next to the bare specifier, so the
  // control room entry resolves to the SDK's own manager entry in the
  // consumer's bundler instead of being inlined here as a second copy.
  external: ['vue', '@seatlayer/js', '@seatlayer/js/manager', '@seatlayer/core', 'konva'],
});
