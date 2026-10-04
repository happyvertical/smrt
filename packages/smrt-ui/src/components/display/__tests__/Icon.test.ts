/**
 * Component tests for Icon (Sweep S11, #1416).
 *
 * Icon is a presentational SVG primitive: decorative by default (aria-hidden),
 * informative when given an aria-label (role="img"). Tests assert the real API
 * from Icon.svelte — preset/path resolution, size/color, and axe-cleanliness in
 * both decorative and labelled modes.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { act, render } from '@testing-library/svelte';
import { hydrate, tick, unmount } from 'svelte';
import { createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Icon from '../Icon.svelte';
import { registerIcons } from '../icons.svelte.js';

/** The 'check' preset path, used to assert preset resolution. */
const CHECK_PATH = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z';

describe('Icon', () => {
  it('renders an svg that is decorative (aria-hidden) by default', () => {
    const { container } = render(Icon, { props: { name: 'check' } });
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
  });

  it('resolves a named preset to its path', () => {
    const { container } = render(Icon, { props: { name: 'check' } });
    const path = container.querySelector('svg path');
    expect(path).toHaveAttribute('d', CHECK_PATH);
  });

  it('renders a custom path verbatim, taking precedence over name', () => {
    const custom = 'M0 0h10v10H0z';
    const { container } = render(Icon, {
      props: { name: 'check', path: custom },
    });
    const path = container.querySelector('svg path');
    expect(path).toHaveAttribute('d', custom);
  });

  it('renders a path with no shape for an unknown preset name', () => {
    // finalPath resolves to '' for an unknown preset; Svelte omits the empty
    // `d` attribute entirely, so the path element renders without a shape.
    const { container } = render(Icon, { props: { name: 'does-not-exist' } });
    const path = container.querySelector('svg path');
    expect(path).toBeInTheDocument();
    expect(path).not.toHaveAttribute('d');
  });

  it('becomes informative (role=img + aria-label) when given an aria-label', () => {
    const { container } = render(Icon, {
      props: { name: 'search', 'aria-label': 'Search' },
    });
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Search');
    expect(svg).toHaveAttribute('aria-hidden', 'false');
  });

  it('converts a numeric size to a px width/height', () => {
    const { container } = render(Icon, { props: { name: 'menu', size: 32 } });
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '32px');
    expect(svg).toHaveAttribute('height', '32px');
  });

  it('passes a string size through unchanged', () => {
    const { container } = render(Icon, {
      props: { name: 'menu', size: '1.5em' },
    });
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '1.5em');
    expect(svg).toHaveAttribute('height', '1.5em');
  });

  it('applies the color prop as the svg fill', () => {
    const { container } = render(Icon, {
      props: { name: 'menu', color: '#ff0000' },
    });
    expect(container.querySelector('svg')).toHaveAttribute('fill', '#ff0000');
  });

  it('uses currentColor as the default fill', () => {
    const { container } = render(Icon, { props: { name: 'menu' } });
    expect(container.querySelector('svg')).toHaveAttribute(
      'fill',
      'currentColor',
    );
  });

  it('applies a custom viewBox', () => {
    const { container } = render(Icon, {
      props: { name: 'menu', viewBox: '0 0 48 48' },
    });
    expect(container.querySelector('svg')).toHaveAttribute(
      'viewBox',
      '0 0 48 48',
    );
  });

  it('is axe-clean when decorative', async () => {
    const { container } = render(Icon, { props: { name: 'close' } });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean when labelled', async () => {
    const { container } = render(Icon, {
      props: { name: 'close', 'aria-label': 'Close dialog' },
    });
    await expectNoA11yViolations(container);
  });
});

const cleanupRegistrations: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanupRegistrations.splice(0)) cleanup();
});

describe('Icon catalog and application registration', () => {
  it.each([
    'alert',
    'warning',
    'info',
    'home',
    'user',
    'settings',
    'trash',
    'edit',
    'calendar',
    'clock',
    'camera',
    'upload',
    'download',
  ])('ships a nonempty %s glyph', (name) => {
    const { container } = render(Icon, { props: { name } });
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
  });

  it('updates already mounted icons when an application set is registered and removed', async () => {
    const { container } = render(Icon, { props: { name: 'shop-machine' } });
    const path = container.querySelector('path');
    expect(path).not.toHaveAttribute('d');
    let cleanup = () => {};
    await act(() => {
      cleanup = registerIcons({ 'shop-machine': 'M2 2h20v20H2z' });
    });
    cleanupRegistrations.push(cleanup);
    expect(path).toHaveAttribute('d', 'M2 2h20v20H2z');
    await act(cleanup);
    expect(path).not.toHaveAttribute('d');
  });

  it('preserves override precedence and supports out-of-order, repeated cleanup', async () => {
    const { container } = render(Icon, { props: { name: 'check' } });
    const path = container.querySelector('path');
    const first = registerIcons({ check: 'M1 1h2v2H1z' });
    const second = registerIcons({ check: 'M3 3h4v4H3z' });
    cleanupRegistrations.push(first, second);
    await act(() => {});
    expect(path).toHaveAttribute('d', 'M3 3h4v4H3z');
    await act(first);
    expect(path).toHaveAttribute('d', 'M3 3h4v4H3z');
    await act(first);
    expect(path).toHaveAttribute('d', 'M3 3h4v4H3z');
    await act(second);
    expect(path).toHaveAttribute('d', CHECK_PATH);
  });

  it('keeps explicit path higher priority than a registered name', () => {
    cleanupRegistrations.push(registerIcons({ check: 'M1 1h2v2H1z' }));
    const { container } = render(Icon, {
      props: {
        name: 'check',
        path: 'M0 0h10v10H0z',
        'aria-label': 'Custom check',
      },
    });
    expect(container.querySelector('path')).toHaveAttribute(
      'd',
      'M0 0h10v10H0z',
    );
    expect(container.querySelector('svg')).toHaveAccessibleName('Custom check');
  });

  it('snapshots caller maps and rejects malformed mixed sets atomically', () => {
    const icons = { brand: 'M1 1h2v2H1z' };
    cleanupRegistrations.push(registerIcons(icons));
    icons.brand = 'M3 3h4v4H3z';
    expect(() =>
      registerIcons({ brand: 'M5 5h6v6H5z', bad: 3 } as unknown as Record<
        string,
        string
      >),
    ).toThrow(TypeError);
    expect(() => registerIcons({ '': 'M1 1h2v2H1z' })).toThrow(TypeError);
    expect(() => registerIcons({ empty: '' })).toThrow(TypeError);
    const { container } = render(Icon, { props: { name: 'brand' } });
    expect(container.querySelector('path')).toHaveAttribute('d', 'M1 1h2v2H1z');
  });

  it('does not resolve inherited map properties or builtin prototype names', () => {
    cleanupRegistrations.push(
      registerIcons(Object.create({ inherited: 'M1 1h2v2H1z' })),
    );
    for (const name of ['inherited', 'toString', '__proto__', 'constructor']) {
      const { container } = render(Icon, { props: { name } });
      expect(container.querySelector('path')).not.toHaveAttribute('d');
    }
  });
});

it('renders registered icons on the server and hydrates with the same application set', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [svelte()],
    root: process.cwd(),
    server: { middlewareMode: true },
  });
  const custom = 'M4 4h16v16H4z';
  const unregisterClient = registerIcons({ brand: custom });
  cleanupRegistrations.push(unregisterClient);
  try {
    const { default: ServerIcon } = await vite.ssrLoadModule(
      '/src/components/display/Icon.svelte',
    );
    const { registerIcons: registerServerIcons } = await vite.ssrLoadModule(
      '/src/components/display/icons.svelte.ts',
    );
    const unregisterServer = registerServerIcons({ brand: custom });
    try {
      const { render: renderSsr } = await vite.ssrLoadModule('svelte/server');
      const props = { name: 'brand', 'aria-label': 'Brand' };
      const result = await renderSsr(ServerIcon, { props });
      expect(result.body).toContain(`d="${custom}"`);
      const host = document.createElement('div');
      host.innerHTML = result.body;
      document.body.append(host);
      const instance = hydrate(Icon, { target: host, props });
      try {
        expect(host.querySelector('svg')).toHaveAccessibleName('Brand');
        expect(host.querySelector('path')).toHaveAttribute('d', custom);
        const override = registerIcons({ brand: 'M2 2h20v20H2z' });
        cleanupRegistrations.push(override);
        await tick();
        expect(host.querySelector('path')).toHaveAttribute(
          'd',
          'M2 2h20v20H2z',
        );
      } finally {
        await unmount(instance);
        host.remove();
      }
    } finally {
      unregisterServer();
    }
  } finally {
    await vite.close();
  }
});
