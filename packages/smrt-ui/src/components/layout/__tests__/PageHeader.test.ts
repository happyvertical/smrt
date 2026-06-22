/**
 * Component tests for the PageHeader layout primitive (Sweep S11, #1416).
 *
 * PageHeader renders a top-level <header> (banner landmark) with an <h1>
 * title, optional subtitle, optional back link, and actions/children snippets.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import PageHeader from '../PageHeader.svelte';

function snippet(html: string) {
  return createRawSnippet(() => ({ render: () => html }));
}

describe('PageHeader', () => {
  it('renders the title as a level-1 heading', () => {
    render(PageHeader, { props: { title: 'Dashboard' } });
    const heading = screen.getByRole('heading', {
      name: 'Dashboard',
      level: 1,
    });
    expect(heading).toBeInTheDocument();
  });

  it('renders a top-level banner landmark', () => {
    render(PageHeader, { props: { title: 'Dashboard' } });
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('renders the optional subtitle', () => {
    render(PageHeader, {
      props: { title: 'Dashboard', subtitle: 'Overview of your account' },
    });
    expect(screen.getByText('Overview of your account')).toBeInTheDocument();
  });

  it('renders a back link with the default label when backHref is set', () => {
    render(PageHeader, {
      props: { title: 'Detail', backHref: '/list' },
    });
    const link = screen.getByRole('link', { name: 'Back' });
    expect(link).toHaveAttribute('href', '/list');
  });

  it('uses a custom back label', () => {
    render(PageHeader, {
      props: { title: 'Detail', backHref: '/list', backLabel: 'All items' },
    });
    expect(screen.getByRole('link', { name: 'All items' })).toBeInTheDocument();
  });

  it('renders the actions snippet', () => {
    render(PageHeader, {
      props: {
        title: 'Detail',
        actions: snippet('<button type="button">Edit</button>'),
      },
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('renders extra children below the title', () => {
    render(PageHeader, {
      props: {
        title: 'Detail',
        children: snippet('<p>Extra content</p>'),
      },
    });
    expect(screen.getByText('Extra content')).toBeInTheDocument();
  });

  it('omits the back link when backHref is not provided', () => {
    render(PageHeader, { props: { title: 'Detail' } });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('is axe-clean with subtitle, back link, and actions', async () => {
    const { container } = render(PageHeader, {
      props: {
        title: 'Settings',
        subtitle: 'Manage your preferences',
        backHref: '/home',
        actions: snippet('<button type="button">Save</button>'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
