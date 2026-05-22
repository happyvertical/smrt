import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Tests live in `__tests__/` (outside `template/`) so they aren't
    // copied into consumer projects by `copyTemplate()`. They import the
    // template source directly to verify behavior.
    include: ['__tests__/**/*.test.ts'],
    // The template's tsconfig extends `./.svelte-kit/tsconfig.json`, which
    // only exists after a consumer runs `svelte-kit sync`. This setup
    // writes a minimal stub before tests run and removes it after.
    globalSetup: ['./__tests__/setup/svelte-kit-stub.ts'],
  },
});
