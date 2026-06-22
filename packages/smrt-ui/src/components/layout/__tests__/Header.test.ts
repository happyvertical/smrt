/**
 * Component tests for the Header (site header) layout primitive (Sweep S11, #1416).
 *
 * Header renders a top-level <header> (banner landmark) wrapping a Container,
 * with optional logo and nav snippets.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Header from '../Header.svelte';

function snippet(html: string) {
  return createRawSnippet(() => ({ render: () => html }));
}

describe('Header', () => {
  it('renders a top-level banner landmark', () => {
    render(Header, { props: {} });
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('renders the logo snippet', () => {
    render(Header, {
      props: { logo: snippet('<h1>Acme</h1>') },
    });
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeInTheDocument();
  });

  it('renders the nav snippet inside a navigation landmark', () => {
    render(Header, {
      props: { nav: snippet('<a href="/about">About</a>') },
    });
    const nav = screen.getByRole('navigation');
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'About' })).toBeInTheDocument();
  });

  it('omits logo and nav when their snippets are not provided', () => {
    const { container } = render(Header, { props: {} });
    expect(container.querySelector('.logo')).toBeNull();
    expect(container.querySelector('.nav')).toBeNull();
  });

  it('is axe-clean with logo and nav', async () => {
    const { container } = render(Header, {
      props: {
        logo: snippet('<h1><a href="/">Acme</a></h1>'),
        nav: snippet('<a href="/about">About</a>'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
