// @vitest-environment jsdom
/**
 * Playground smoke tests (#2272).
 *
 * Registering `@happyvertical/smrt-fields/playground` publishes EVERY entry in
 * the module, and `PlaygroundHost` mounts the selected one bare — no
 * `<svelte:boundary>` around it. So a preview that throws on mount is not a
 * contained failure the host can route around; a host cannot offer the sound
 * entry without also offering one that breaks the page.
 *
 * That is exactly how #2272 shipped: the `Policy-Driven Form` preview rendered
 * `<FormHelp>` outside its `<FieldPolicyProvider>`, and no unit test could see
 * it, because `FormHelp`'s own tests always mount it through a provider
 * fixture — they exercise the component's contract, never the preview's
 * composition.
 *
 * These tests therefore load and MOUNT every exported entry the way
 * `PlaygroundHost` does — one mount per declared mode, with the entry props and
 * mode props merged (`PlaygroundHost.svelte`). Nothing wraps the component, so
 * a preview that needs an ancestor provider must supply its own.
 *
 * Structural types below: this package must not depend on
 * `@happyvertical/smrt-playground`, so the module shape is asserted, not
 * imported.
 */
import { cleanup, render } from '@happyvertical/smrt-vitest/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import playground from '../playground.js';

interface PreviewModeConfig {
  label?: string;
  props?: Record<string, unknown>;
}

interface PreviewEntry {
  id: string;
  title: string;
  props?: Record<string, unknown>;
  modes?: Record<string, PreviewModeConfig | true>;
  loadComponent: () => Promise<unknown>;
}

const entries = playground.entries as readonly PreviewEntry[];

afterEach(() => {
  cleanup();
});

describe('smrt-fields playground module', () => {
  it('publishes the field-policy previews', () => {
    expect(playground.packageName).toBe('@happyvertical/smrt-fields');
    expect(entries.map((entry) => entry.id)).toEqual([
      'policy-form',
      'object-form',
    ]);

    for (const entry of entries) {
      expect(entry.loadComponent).toEqual(expect.any(Function));
      expect(entry.modes).toHaveProperty('mock');
    }
  });

  // One case per entry/mode so a failure names the broken preview.
  for (const entry of entries) {
    for (const [mode, config] of Object.entries(entry.modes ?? {})) {
      it(`mounts the "${entry.title}" preview in ${mode} mode`, async () => {
        const loaded = await entry.loadComponent();
        const component =
          typeof loaded === 'function'
            ? loaded
            : (loaded as { default: unknown }).default;
        expect(component).toEqual(expect.any(Function));

        // Mirror PlaygroundHost: entry props, then mode props. Nothing else.
        const props = {
          ...(entry.props ?? {}),
          ...(config === true ? {} : (config.props ?? {})),
        };

        const { container } = render(component as never, {
          props: props as never,
        });

        expect(container.textContent?.trim()).not.toBe('');
      });
    }
  }
});
