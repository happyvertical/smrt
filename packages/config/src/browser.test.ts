import { describe, expect, it } from 'vitest';
import * as browserEntry from './browser.js';
import * as nodeEntry from './index.js';

describe('browser entry (#3625)', () => {
  it('exposes the same runtime surface as the Node entry', () => {
    expect(Object.keys(browserEntry).sort()).toEqual(
      Object.keys(nodeEntry).sort(),
    );
  });

  it('rejects loadConfig() with an explicit error instead of returning {}', async () => {
    await expect(browserEntry.loadConfig()).rejects.toThrow(
      /not available in a browser build/,
    );
  });

  it('still resolves config seeded with setConfig()', () => {
    browserEntry.clearCache();
    browserEntry.setConfig({ packages: { demo: { answer: 42 } } });
    expect(browserEntry.getPackageConfig('demo')).toEqual({ answer: 42 });
    browserEntry.clearCache();
  });
});
