import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one test database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    globalSetup: ['test/global-setup.ts'],
  },
});
