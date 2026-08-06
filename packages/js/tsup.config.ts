import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/manager.ts` is a SEPARATE entry so a host that only renders the
  // organizer cockpit never pays for the buyer SDK in the main barrel
  // (SeatPicker, SeatingChart, EmbeddedDesigner) or the engine code that only
  // those reach. Shared code lands in shared chunks, so a host that imports
  // both entries still ships one copy of each. See src/manager.ts.
  entry: ['src/index.ts', 'src/manager.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // core + konva stay external so the whole SDK shares one engine + one konva.
  external: ['@seatlayer/core', 'konva'],
});
