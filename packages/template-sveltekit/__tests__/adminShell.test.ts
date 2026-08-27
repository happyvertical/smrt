import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesDir = join(__dirname, '..', 'template', 'src', 'routes');

describe('application shell', () => {
  const layout = readFileSync(join(routesDir, '+layout.svelte'), 'utf8');
  const layoutServer = readFileSync(
    join(routesDir, '+layout.server.ts'),
    'utf8',
  );
  const settings = readFileSync(
    join(routesDir, 'settings', '+page.svelte'),
    'utf8',
  );

  it('wraps AdminShell in the current provider and theme stack', () => {
    expect(layout).toContain("import { Provider } from '@happyvertical/smrt-svelte'");
    expect(layout).toContain("ThemeProvider } from '@happyvertical/smrt-ui/themes'");
    expect(layout).toContain("@happyvertical/smrt-ui/themes/styles/fonts.css");
    const providerIndex = layout.indexOf('<Provider {webmcp}>');
    const themeIndex = layout.indexOf('<ThemeProvider');
    const shellIndex = layout.indexOf('<AdminShell');
    expect(providerIndex).toBeGreaterThanOrEqual(0);
    expect(themeIndex).toBeGreaterThan(providerIndex);
    expect(shellIndex).toBeGreaterThan(themeIndex);
    expect(layout).toContain('preset="smrt"');
  });

  it('uses a small explicit TenantNav instead of generating broken page links', () => {
    expect(layout).toContain('const nav: ShellNavItem[]');
    expect(layout).toContain('<TenantNav items={nav} {currentHref} />');
    expect(layout).not.toContain('tenantNavFromManifest');
  });

  it('loads session tenant and selection state on the server', () => {
    expect(layoutServer).toContain('activeTenantId: locals.tenantId');
    expect(layoutServer).toContain(
      'selectedTenantSlug: locals.selectedTenantSlug',
    );
  });

  it('keeps the current ShellSettingsPanel integration', () => {
    expect(settings).toContain('ShellSettingsPanel');
    expect(settings).toContain("from '@happyvertical/smrt-svelte/workspace'");
  });
});
