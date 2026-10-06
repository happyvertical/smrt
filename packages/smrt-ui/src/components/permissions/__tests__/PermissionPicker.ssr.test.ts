import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

describe('PermissionPicker SSR', () => {
  it('renders the complete grouped catalog and exact retry selections without JavaScript', async () => {
    const server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      plugins: [svelte()],
      server: { middlewareMode: true },
    });
    try {
      const [{ default: PermissionPicker }, { render }] = await Promise.all([
        server.ssrLoadModule(
          '/src/components/permissions/PermissionPicker.svelte',
        ),
        server.ssrLoadModule('svelte/server'),
      ]);
      const { body } = render(PermissionPicker, {
        props: {
          permissions: [
            {
              slug: 'tenant.settings.read',
              name: 'Read settings',
              description: 'View workspace configuration.',
              category: 'Workspace',
            },
            {
              slug: 'tenant.settings.manage',
              name: 'Manage settings',
              category: 'Workspace',
            },
            { slug: 'projects.read', description: 'View projects.' },
          ],
          selected: ['tenant.settings.manage', 'projects.read'],
          name: 'grant',
        },
      });

      expect(body).toContain('Workspace');
      expect(body).toContain('Projects');
      expect(body).toContain('Read settings');
      expect(body).toContain('View workspace configuration.');
      expect(body).toMatch(
        /name="grant"[^>]*value="tenant\.settings\.manage"[^>]*checked/,
      );
      expect(body).toMatch(
        /name="grant"[^>]*value="projects\.read"[^>]*checked/,
      );
      expect(body).toMatch(
        /name="grant"[^>]*value="tenant\.settings\.read"(?![^>]*checked)/,
      );
    } finally {
      await server.close();
    }
  });
});
