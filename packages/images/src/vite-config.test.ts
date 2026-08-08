import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.js';

describe('smrt-images Vite config (#2199)', () => {
  it('anchors generated-output side effects to the images package', async () => {
    const config = await viteConfig({ command: 'serve', mode: 'development' });
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const smrtGenerator = config.plugins?.find(
      (plugin) =>
        plugin &&
        typeof plugin === 'object' &&
        plugin.name === 'smrt-auto-service',
    ) as { api?: { options?: { projectRoot?: string } } } | undefined;

    expect(config.root).toBe(packageRoot);
    expect(smrtGenerator?.api?.options?.projectRoot).toBe(packageRoot);
  });
});
