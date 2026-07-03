/**
 * AdminShell adoption tests (issue #1777).
 *
 * The WASD AdminShell is the template's default chrome. These tests pin:
 *   1. The root layout mounts AdminShell around every page and feeds it a
 *      server-built tenant nav — without breaking the home page's server-load
 *      + `invalidate` pattern (that stays covered by `serverLoad.test.ts`).
 *   2. `+layout.server.ts` builds the nav SERVER-SIDE from the SMRT manifest
 *      (no client fetch) and degrades gracefully when no manifest exists yet.
 *   3. The settings route drops in `ShellSettingsPanel`.
 *
 * The runtime layout-load test mocks `@happyvertical/smrt-svelte/workspace`:
 * that barrel re-exports Svelte components, which a node-environment vitest
 * (no Svelte plugin) cannot parse. Mocking it keeps the test on the pure
 * nav-building logic while exercising the real `load()` control flow.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesDir = join(__dirname, '..', 'template', 'src', 'routes');

describe('AdminShell adoption (structural)', () => {
  const layout = readFileSync(join(routesDir, '+layout.svelte'), 'utf-8');
  const layoutServer = readFileSync(
    join(routesDir, '+layout.server.ts'),
    'utf-8',
  );
  const settings = readFileSync(
    join(routesDir, 'settings', '+page.svelte'),
    'utf-8',
  );
  const page = readFileSync(join(routesDir, '+page.svelte'), 'utf-8');

  it('layout mounts AdminShell around the page children', () => {
    expect(layout).toContain('AdminShell');
    // The active page renders inside the shell via the children snippet.
    expect(layout).toMatch(/\{@render children\(\)\}/);
    expect(layout).toContain(
      "from '@happyvertical/smrt-svelte/workspace'",
    );
  });

  it('layout feeds the tenant nav from server layout data (no client fetch)', () => {
    expect(layout).toContain('TenantNav');
    // Nav comes from `data` (the server load), not a fetch on mount.
    expect(layout).toMatch(/items=\{data\.nav\}/);
    expect(layout).not.toMatch(/onMount/);
    expect(layout).not.toMatch(/fetch\(/);
  });

  it('layout themes the shell via ThemeProvider + the SMRT font stack', () => {
    // Standard SMRT theming: ThemeProvider (token variables) wraps AdminShell,
    // and fonts.css loads the type stack. Order matters — ThemeProvider must
    // open before AdminShell so the tokens cascade into the shell.
    expect(layout).toContain(
      "import { ThemeProvider } from '@happyvertical/smrt-ui/themes'",
    );
    expect(layout).toContain(
      "import '@happyvertical/smrt-ui/themes/styles/fonts.css'",
    );
    const providerIndex = layout.indexOf('<ThemeProvider');
    const shellIndex = layout.indexOf('<AdminShell');
    expect(providerIndex).toBeGreaterThanOrEqual(0);
    expect(shellIndex).toBeGreaterThan(providerIndex);
    expect(layout).toContain('</ThemeProvider>');
  });

  it('layout server load builds nav via tenantNavFromManifest and returns it', () => {
    expect(layoutServer).toContain('tenantNavFromManifest');
    // Reads the same generated manifest the runtime seeds from.
    expect(layoutServer).toMatch(/['"]\.smrt['"],\s*['"]manifest\.json['"]/);
    expect(layoutServer).toMatch(/return \{ nav \}/);
  });

  it('settings route drops in ShellSettingsPanel', () => {
    expect(settings).toContain('ShellSettingsPanel');
    expect(settings).toContain(
      "from '@happyvertical/smrt-svelte/workspace'",
    );
  });

  it('home page renders inside the shell (no nested <main> element) and keeps invalidate', () => {
    // AdminShell owns the <main>; the page uses a plain wrapper instead of
    // opening a second <main> (which would be invalid nested-main HTML).
    expect(page).toContain('<div class="page">');
    expect(page).not.toContain('</main>');
    // Server-load refresh convention is preserved.
    expect(page).toContain("invalidate('smrt:items')");
  });
});

describe('layout server load (runtime)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns an empty nav when no manifest is present, without throwing', async () => {
    // The pure nav builder is mocked so the node test never loads the Svelte
    // barrel. It should not even be called on the no-manifest path, but if the
    // control flow changed to call it, the mock keeps the test deterministic.
    const tenantNavFromManifest = vi.fn(() => []);
    vi.doMock('@happyvertical/smrt-svelte/workspace', () => ({
      tenantNavFromManifest,
    }));

    const { load } = await import('../template/src/routes/+layout.server.js');
    // cwd is the package root here; there is no `.smrt/manifest.json`, so the
    // load must degrade to an empty rail instead of failing the layout.
    const result = await (
      load as unknown as (event: unknown) => Promise<{ nav: unknown[] }>
    )({});

    expect(result).toEqual({ nav: [] });
    expect(tenantNavFromManifest).not.toHaveBeenCalled();
  });
});
