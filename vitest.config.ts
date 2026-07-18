import { defineConfig } from 'vitest/config';

// Wrapper unit tests only. The engine (packages/core) is a generated mirror of
// the app and is tested there, not here.
export default defineConfig({
  test: {
    // jsdom does not fetch iframe subresources by default, so a mounted Designer
    // iframe never hits the network during unit tests.
    environment: 'jsdom',
    include: ['packages/*/test/**/*.test.ts'],
  },
});
