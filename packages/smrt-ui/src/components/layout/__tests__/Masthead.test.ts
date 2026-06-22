/**
 * Component tests for the Masthead layout primitive (Sweep S11, #1416).
 *
 * Masthead renders a date (as a <time>), an optional location link, and
 * nav/mobileNav snippets inside <nav> landmarks. The root is a plain <div>
 * (no banner landmark). The mobile home icon's aria-label is i18n-resolved;
 * useI18n() falls back to registered English defaults outside a Provider.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Masthead from '../Masthead.svelte';

function snippet(html: string) {
  return createRawSnippet(() => ({ render: () => html }));
}

describe('Masthead', () => {
  it('renders a provided date string', () => {
    render(Masthead, { props: { date: 'Monday, June 1, 2026' } });
    expect(screen.getAllByText('Monday, June 1, 2026').length).toBeGreaterThan(
      0,
    );
  });

  it('renders the date inside a <time> element', () => {
    const { container } = render(Masthead, {
      props: { date: 'June 1, 2026' },
    });
    const time = container.querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveTextContent('June 1, 2026');
  });

  it('wraps the date in a link when dateHref is provided', () => {
    render(Masthead, {
      props: { date: 'June 1, 2026', dateHref: '/archive/2026-06-01' },
    });
    const link = screen.getByRole('link', { name: 'June 1, 2026' });
    expect(link).toHaveAttribute('href', '/archive/2026-06-01');
  });

  it('renders the location as a link to locationHref', () => {
    render(Masthead, {
      props: { location: 'New York', locationHref: '/ny' },
    });
    const link = screen.getByRole('link', { name: 'New York' });
    expect(link).toHaveAttribute('href', '/ny');
  });

  it('omits the location link when location is empty', () => {
    const { container } = render(Masthead, { props: { location: '' } });
    expect(container.querySelector('.location')).toBeNull();
  });

  it('renders the nav snippet inside a navigation landmark', () => {
    render(Masthead, {
      props: { nav: snippet('<a href="/sections">Sections</a>') },
    });
    // Masthead renders both a desktop and a mobile layout in the DOM (CSS hides
    // one); with no `mobileNav`, the mobile layout falls back to `nav`, so the
    // link appears in both. Assert at least one navigation landmark + link.
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('link', { name: 'Sections' }).length,
    ).toBeGreaterThan(0);
  });

  it('renders a distinct mobileNav snippet when provided', () => {
    render(Masthead, {
      props: {
        nav: snippet('<a href="/sections">Sections</a>'),
        mobileNav: snippet('<a href="/menu">Menu</a>'),
      },
    });
    expect(screen.getByRole('link', { name: 'Menu' })).toBeInTheDocument();
  });

  it('exposes a home icon link with an accessible (i18n-resolved) label', () => {
    render(Masthead, { props: { locationHref: '/home' } });
    const link = screen.getByRole('link', { name: 'Home' });
    expect(link).toHaveAttribute('href', '/home');
  });

  it('labels the desktop and mobile nav landmarks distinctly', () => {
    // Masthead emits both a desktop and a mobile layout (one CSS-hidden). Each
    // <nav> carries a distinct aria-label so the two landmarks stay unique.
    render(Masthead, {
      props: { nav: snippet('<a href="/sections">Sections</a>') },
    });
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Mobile' }),
    ).toBeInTheDocument();
  });

  it('is axe-clean with date, location, and nav', async () => {
    const { container } = render(Masthead, {
      props: {
        date: 'June 1, 2026',
        dateHref: '/archive',
        location: 'New York',
        locationHref: '/ny',
        nav: snippet('<a href="/sections">Sections</a>'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
