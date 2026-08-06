import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/manager.ts` is a SEPARATE entry — the cockpit without the buyer
  // components. See src/manager.ts and @seatlayer/js's src/manager.ts.
  entry: ['src/index.ts', 'src/manager.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // `@seatlayer/js/manager` is externalized alongside the bare specifier so the
  // cockpit entry resolves to the SDK's own manager entry at the consumer's
  // bundler, rather than being inlined here as a second copy.
  external: ['react', 'react-dom', '@seatlayer/js', '@seatlayer/js/manager', '@seatlayer/core', 'konva'],
});
