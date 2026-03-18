import { describe, expect, it } from 'vitest';
import { smrtVitestPlugin } from '../index.js';

describe('smrtVitestPlugin config', () => {
  it('injects the setup file into root config and mutates project configs', () => {
    const plugin = smrtVitestPlugin();
    const userConfig = {
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
    };
    const config = plugin.config?.(userConfig as any);

    expect(config).toEqual({
      test: {
        setupFiles: ['existing-root-setup', '@happyvertical/smrt-vitest/setup'],
      },
    });

    expect(userConfig).toMatchObject({
      test: {
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
    const userConfig = {
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
    };
    const config = plugin.config?.(userConfig as any);

    expect(config).toEqual({
      test: {
        setupFiles: ['@happyvertical/smrt-vitest/setup'],
      },
    });

    expect(userConfig).toMatchObject({
      test: {
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
