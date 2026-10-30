import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo-name>/. The deploy workflow sets
// BASE_PATH; local development uses '/'.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
