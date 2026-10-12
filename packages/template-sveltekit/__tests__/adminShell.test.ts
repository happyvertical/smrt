import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesDir = join(__dirname, '..', 'template', 'src', 'routes');
const read = (path: string) => readFileSync(join(routesDir, path), 'utf8');

/**
 * The shell, owner setup form, and settings page are shipped by
 * `@happyvertical/smrt-svelte/app` (#3374) and tested there; their rendering
 * is proven end to end by the M5 browser gate. These cases pin the app-owned
 * inputs the template passes.
 */
describe('application shell', () => {
  const layout = read('+layout.svelte');

  it('uses the shipped AppShell with app-owned navigation only', () => {
    expect(layout).toContain(
      "import { AppShell } from '@happyvertical/smrt-svelte/app'",
    );
    expect(layout).toContain('const nav: ShellNavItem[]');
    expect(layout).toContain('{nav}');
    expect(layout).toContain('currentHref={page.url.pathname}');
    expect(layout).not.toContain('tenantNavFromManifest');
    // Provider, ThemeProvider, theme CSS, and AdminShell come from AppShell.
    expect(layout).not.toMatch(/<(Provider|ThemeProvider|AdminShell)\b/);
  });

  it('drops dead AppShell props and gives nav items icons', () => {
    expect(layout).not.toContain('subtitle=');
    expect(layout).not.toContain('tenantLabel');
    expect(layout).not.toContain('appPanelDocs');
    expect(layout).toContain("icon: 'book'");
    expect(layout).toContain("icon: 'settings'");
  });

  it('registers diagnostics only for a signed-in session and generated tools read-only', () => {
    expect(layout).toContain(
      'runtimeDiagnostics={data.session.authenticated}',
    );
    expect(layout).toContain("effects: ['read'] as const");
    expect(layout).toContain("'modelContext' in document");
  });

  it('wires the account menu, sign-out, phone tab bar and chrome-free setup', () => {
    expect(layout).toContain('user={data.session.user}');
    expect(layout).toContain('onSignOut={signOut}');
    expect(layout).toContain("import { signOut } from '$lib/sign-out'");
    expect(layout).toContain('phoneTabBar');
    expect(layout).toContain("chrome={!page.route.id?.startsWith('/setup')}");
    expect(layout).not.toContain('TODO(');
    expect(read('settings/+page.svelte')).toContain(
      '<ShellSettingsPage onSignOut={signOut} />',
    );
    expect(read('../lib/sign-out.ts')).toContain("method: 'POST'");
    expect(read('sign-out/+server.ts')).toContain(
      'export const POST = createSignOutHandler(runtime)',
    );
    expect(read('../lib/sign-out.ts')).toContain('if (!response.ok)');
  });

  it('mounts the shipped owner setup form over the runtime action', () => {
    expect(read('setup/+page.svelte')).toContain(
      '<OwnerSetupForm {data} {form} {enhance} title="s-m-r-t app" />',
    );
    expect(read('setup/+page.server.ts')).toContain(
      'createOwnerSetupPage(runtime',
    );
  });

  it('mounts the shipped settings page inside the shell', () => {
    expect(read('settings/+page.svelte')).toContain('<ShellSettingsPage');
  });
});

describe('document head', () => {
  const html = read('../app.html');

  it('declares safe-area, color scheme, theme colors and an SVG icon', () => {
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('(prefers-color-scheme: light)');
    expect(html).toContain('(prefers-color-scheme: dark)');
    expect(html).toContain('rel="icon" type="image/svg+xml"');
    expect(read('../../static/favicon.svg')).toContain('currentColor');
  });
});
