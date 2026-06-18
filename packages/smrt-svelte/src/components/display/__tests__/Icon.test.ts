/**
 * Component tests for Icon (Sweep S11, #1416).
 *
 * Icon is a presentational SVG primitive: decorative by default (aria-hidden),
 * informative when given an aria-label (role="img"). Tests assert the real API
 * from Icon.svelte — preset/path resolution, size/color, and axe-cleanliness in
 * both decorative and labelled modes.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Icon from '../Icon.svelte';

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
