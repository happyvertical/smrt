import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import templateConfig from '../template/smrt.config.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'template', 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8');

describe('inference and prompt settings sections', () => {
  it('consumes the packages whose tables the sections read and write', () => {
    expect(templateConfig.consumer.packages).toEqual(
      expect.arrayContaining([
        '@happyvertical/smrt-inference',
        '@happyvertical/smrt-prompts',
        '@happyvertical/smrt-preferences',
      ]),
    );
  });

  it('lists both sections in the settings menu', () => {
    const menu = read('routes/settings/+page.svelte');
    expect(menu).toContain("id: 'inference'");
    expect(menu).toContain("id: 'prompts'");
    expect(menu).toContain('{extraSections}');
  });

  it('registers the preference kind and permissions before the runtime exists', () => {
    const smrt = read('lib/server/smrt.ts');
    const registration = smrt.indexOf("import './settings-registry'");
    expect(registration).toBeGreaterThan(-1);
    expect(registration).toBeLessThan(
      smrt.indexOf('createSmrtSvelteKitRuntime({'),
    );
    const registry = read('lib/server/settings-registry.ts');
    expect(registry).toContain('registerPreferenceKind(inferencePreferenceKind');
    expect(registry).toContain('INFERENCE_PERMISSION_DEFINITIONS');
    expect(registry).toContain("'prompts.customize'");
  });

  it('applies stored bindings through a lazy override resolver', () => {
    expect(read('lib/server/settings.ts')).toContain(
      "overrides: () => runtime.classOptions('InferenceOverride')",
    );
    expect(read('hooks.server.ts')).toContain('installInferenceOverrides()');
  });

  it('keeps the permission decision on the server, never in the panel', () => {
    const settings = read('lib/server/settings.ts');
    // The session's own check is the permission snapshot; the authorizer that
    // gates writes on it lives in smrt-inference's host.
    expect(settings).toContain('can: (permission) => permissions.has(permission)');
    expect(settings).toContain('session.can(PROMPTS_CUSTOMIZE_PERMISSION)');
    expect(settings).toContain('PROMPTS_CUSTOMIZE_PERMISSION');
    for (const route of ['inference', 'prompts']) {
      expect(read(`routes/settings/${route}/+page.server.ts`)).toContain(
        'requireSettingsSession(locals)',
      );
    }
  });
});
