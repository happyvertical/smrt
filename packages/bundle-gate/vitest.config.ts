import { defineConfig } from 'vitest/config';

// Intentionally NOT using smrtVitestPlugin: this package never instantiates
// SmrtObject classes. Its specs drive programmatic `vite build` runs against
// the *published dist surface* of chat/personas/messages, so the workspace
// src aliases and manifest bootstrap the plugin provides would only distort
// the consumer's viewpoint.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.spec.ts'],
    // Each spec performs a full SSR bundle of the consumer surface.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
