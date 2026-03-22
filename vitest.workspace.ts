import { fileURLToPath } from 'node:url';

export { smrtVitestPlugin } from './packages/vitest/src/index.ts';

export const smrtVitestSetupPath = fileURLToPath(
  new URL('./packages/vitest/src/setup.ts', import.meta.url),
);
