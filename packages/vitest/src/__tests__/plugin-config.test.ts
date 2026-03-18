import { describe, expect, it } from 'vitest';
import { smrtVitestPlugin } from '../index.js';

describe('smrtVitestPlugin config', () => {
  it('injects the setup file into root and project test configs', () => {
    const plugin = smrtVitestPlugin();
    const config = plugin.config?.({
      test: {
        setupFiles: ['existing-root-setup'],
        projects: [
          {
            test: {
              name: 'sqlite',
              setupFiles: ['existing-project-setup'],
            },
          },
          {
            test: {
              name: 'json',
            },
          },
        ],
      },
    } as any);

    expect(config).toMatchObject({
      test: {
        setupFiles: ['existing-root-setup', '@happyvertical/smrt-vitest/setup'],
        projects: [
          {
            test: {
              setupFiles: [
                'existing-project-setup',
                '@happyvertical/smrt-vitest/setup',
              ],
            },
          },
          {
            test: {
              setupFiles: ['@happyvertical/smrt-vitest/setup'],
            },
          },
        ],
      },
    });
  });

  it('does not duplicate the setup file when already configured', () => {
    const plugin = smrtVitestPlugin();
    const config = plugin.config?.({
      test: {
        setupFiles: ['@happyvertical/smrt-vitest/setup'],
        projects: [
          {
            test: {
              name: 'sqlite',
              setupFiles: ['@happyvertical/smrt-vitest/setup'],
            },
          },
        ],
      },
    } as any);

    expect(config).toMatchObject({
      test: {
        setupFiles: ['@happyvertical/smrt-vitest/setup'],
        projects: [
          {
            test: {
              setupFiles: ['@happyvertical/smrt-vitest/setup'],
            },
          },
        ],
      },
    });
  });
});
