import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import { PACKAGE_BROWSER_CAPABILITY } from '../../manifest/browser-capability.generated.js';
import { ManifestGenerator } from '../manifest-generator.js';
import {
  applyRecipeDemo,
  getPackageBrowserCapability,
} from '../recipe-demo-pass.js';
import type { SmartObjectManifest } from '../types.js';

function recipe(extra: Partial<RecipeDefinition> = {}): RecipeDefinition {
  return {
    id: 'shop.pages',
    className: 'PagesRecipe',
    label: 'Pages',
    summary: 'Pages.',
    synonyms: [],
    models: [],
    nav: [],
    requires: [],
    ...extra,
  };
}

function manifest(
  packageName: string,
  recipes: RecipeDefinition[],
): SmartObjectManifest {
  return { version: '1', timestamp: 0, packageName, objects: {}, recipes };
}

describe('generated browser capability table', () => {
  it('measures smrt-core and flags every entry with a known status', () => {
    expect(
      getPackageBrowserCapability('@happyvertical/smrt-core')?.status,
    ).toBe('server-only');
    for (const [name, capability] of Object.entries(
      PACKAGE_BROWSER_CAPABILITY,
    )) {
      expect(name).toMatch(/^@happyvertical\/smrt-/);
      expect(['browser-safe', 'server-only']).toContain(capability.status);
      if (capability.status === 'browser-safe') {
        expect(capability.issues).toBeUndefined();
        expect(capability.via).toBeUndefined();
      }
    }
  });

  it('does not know an unlisted package', () => {
    expect(getPackageBrowserCapability('@shop/pkg')).toBeUndefined();
    expect(getPackageBrowserCapability('toString')).toBeUndefined();
    expect(getPackageBrowserCapability(undefined)).toBeUndefined();
  });
});

describe('applyRecipeDemo', () => {
  it('emits browser and a demo for a measured package', () => {
    const m = manifest('@happyvertical/smrt-core', [recipe()]);
    applyRecipeDemo(m, '@happyvertical/smrt-core');
    expect(m.browser).toEqual(
      PACKAGE_BROWSER_CAPABILITY['@happyvertical/smrt-core'],
    );
    expect(m.recipes?.[0].demo?.mode).toBe('server');
  });

  it('adds nothing for an unmeasured package whose recipe declares nothing', () => {
    const m = manifest('@shop/pkg', [recipe()]);
    applyRecipeDemo(m, '@shop/pkg');
    expect('browser' in m).toBe(false);
    expect('demo' in (m.recipes?.[0] ?? {})).toBe(false);
  });

  it('is idempotent and clears stale output', () => {
    const m = manifest('@shop/pkg', [
      recipe({ demo: { mode: 'live', reasons: [] } }),
    ]);
    m.browser = { status: 'browser-safe' };
    applyRecipeDemo(m, '@shop/pkg');
    expect('browser' in m).toBe(false);
    expect('demo' in (m.recipes?.[0] ?? {})).toBe(false);
  });

  it('fails the build on a contradictory declaration', () => {
    const m = manifest('@happyvertical/smrt-core', [
      recipe({ runtime: 'browser' }),
    ]);
    expect(() => applyRecipeDemo(m, '@happyvertical/smrt-core')).toThrow(
      /contradictory recipe demo declarations[\s\S]*shop\.pages.*"browser"/,
    );
  });

  it('runs inside the generation passes', () => {
    const m = manifest('@shop/pkg', [
      recipe({
        runtime: 'browser',
        providers: [
          {
            id: 'smtp',
            kind: 'email',
            options: ['smtp'],
            required: true,
            secrets: ['SMTP_PASSWORD'],
          },
        ],
      }),
    ]);
    expect(() =>
      new ManifestGenerator().applyGenerationPasses(m, {
        packageName: '@shop/pkg',
      }),
    ).toThrow(/provider "smtp"/);
  });
});
