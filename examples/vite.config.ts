import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@seatlayer/js': resolve(__dirname, '../packages/js/src/index.ts'),
      '@seatlayer/core': resolve(__dirname, '../packages/core/src/index.ts'),
    },
  },
});
