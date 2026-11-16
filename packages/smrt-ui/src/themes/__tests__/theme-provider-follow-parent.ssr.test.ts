/**
 * #5025: the parent's stored choice is unknown at SSR, so a nested provider
 * that follows its parent renders no scheme-keyed attribute of its own and
 * inherits the host's through the cascade (no guess, no hydration mismatch).
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

describe('nested ThemeProvider SSR (#5025)', () => {
  it('a following wrapper carries no scheme of its own until mount; an explicit one does', async () => {
    const server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      plugins: [svelte()],
      server: { middlewareMode: true },
    });
    try {
      const [{ default: Fixture }, { render }] = await Promise.all([
        server.ssrLoadModule(
          '/src/themes/__tests__/theme-provider-follow-parent.fixture.svelte',
        ),
        server.ssrLoadModule('svelte/server'),
      ]);
      const parse = (props: object) => {
        const el = document.createElement('div');
        el.innerHTML = render(Fixture, { props }).body;
        const roots = el.querySelectorAll<HTMLElement>(
          '[data-smrt-component="ThemeProvider"]',
        );
        return { host: roots[0], inner: roots[1] };
      };

      const following = parse({});
      // The root keeps its guess (the host's pre-paint script stamps <html>).
      expect(following.host.hasAttribute('data-color-scheme')).toBe(true);
      expect(following.inner.hasAttribute('data-color-scheme')).toBe(false);
      expect(following.inner.getAttribute('data-theme')).toBe('glass');
      expect(
        following.inner.classList.contains('smrt-theme-provider__dark'),
      ).toBe(false);

      // Scheme-derived accent variables wait for mount too.
      const accented = parse({ innerPrimary: '#cc3300' });
      expect(accented.inner.getAttribute('style') ?? '').not.toContain(
        '--smrt-color-primary',
      );

      const explicit = parse({ innerScheme: 'dark' });
      expect(explicit.inner.getAttribute('data-color-scheme')).toBe('dark');
      const explicitAccent = parse({
        innerScheme: 'dark',
        innerPrimary: '#cc3300',
      });
      expect(explicitAccent.inner.getAttribute('style') ?? '').toContain(
        '--smrt-color-primary',
      );
    } finally {
      await server.close();
    }
  });
});
