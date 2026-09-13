import { describe, expect, it } from 'vitest';
import { resolveSvelteKitConfigImport } from './sveltekit-config-import.js';

describe('resolveSvelteKitConfigImport', () => {
  const projectRoot = '/consumer';
  const routeDir = '/consumer/src/routes/api/widgets/[id]';

  it('preserves the default SvelteKit $lib specifier', () => {
    expect(resolveSvelteKitConfigImport(projectRoot, routeDir, {})).toBe(
      '$lib/server/smrt',
    );
  });

  it('uses $lib for custom config files beneath src/lib', () => {
    expect(
      resolveSvelteKitConfigImport(projectRoot, routeDir, {
        configPath: 'src/lib/server/infra',
        configFileName: 'custom.mts',
      }),
    ).toBe('$lib/server/infra/custom.mts');
  });

  it('uses a portable route-relative specifier outside src/lib', () => {
    expect(
      resolveSvelteKitConfigImport(projectRoot, routeDir, {
        configPath: 'src/server',
        configFileName: 'smrt-config.ts',
      }),
    ).toBe('../../../../server/smrt-config');
  });

  it('normalizes Windows-style configured paths', () => {
    expect(
      resolveSvelteKitConfigImport(projectRoot, routeDir, {
        configPath: 'src\\lib\\server',
        configFileName: 'custom.ts',
      }),
    ).toBe('$lib/server/custom');
  });
});
