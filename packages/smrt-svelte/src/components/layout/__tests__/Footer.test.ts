/**
 * Component tests for the Footer layout primitive (Sweep S11, #1416).
 *
 * Footer renders a top-level <footer> (contentinfo landmark) with an
 * i18n-resolved copyright line and optional children (footer links).
 * useI18n() falls back to registered English defaults outside a Provider.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Footer from '../Footer.svelte';

function snippet(html: string) {
  return createRawSnippet(() => ({ render: () => html }));
}

describe('Footer', () => {
  it('renders a top-level contentinfo landmark', () => {
    render(Footer, { props: {} });
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('renders the current year and i18n-resolved rights notice', () => {
    render(Footer, { props: {} });
    const year = String(new Date().getFullYear());
    const copyright = screen.getByText(
      (_, el) =>
        el?.classList.contains('copyright') === true &&
        el.textContent?.includes(year) === true &&
        el.textContent?.includes('All rights reserved.') === true,
    );
    expect(copyright).toBeInTheDocument();
  });

  it('renders the children (footer links)', () => {
    render(Footer, {
      props: {
        children: snippet('<a href="/privacy">Privacy</a>'),
      },
    });
    const link = screen.getByRole('link', { name: 'Privacy' });
    expect(link).toHaveAttribute('href', '/privacy');
  });

  it('omits the footer-links container when no children are provided', () => {
    const { container } = render(Footer, { props: {} });
    expect(container.querySelector('.footer-links')).toBeNull();
  });

  it('is axe-clean with footer links', async () => {
    const { container } = render(Footer, {
      props: {
        children: snippet('<a href="/privacy">Privacy</a>'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
