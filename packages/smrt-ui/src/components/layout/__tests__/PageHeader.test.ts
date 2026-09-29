/**
 * Component tests for the PageHeader layout primitive (Sweep S11, #1416).
 *
 * PageHeader renders a top-level <header> (banner landmark) with an <h1>
 * title, optional subtitle, optional back link, and actions/children snippets.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
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

  it('renders ancestors-only crumbs above the title', () => {
    render(PageHeader, {
      props: {
        title: 'Fair opens Friday',
        crumbs: [
          { label: 'Alpha Times', href: '/sites/alpha' },
          { label: 'Content', href: '/sites/alpha/articles' },
        ],
      },
    });
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toHaveAttribute('data-shell-breadcrumbs');
    const links = nav.querySelectorAll('a');
    expect([...links].map((a) => a.textContent)).toEqual([
      'Alpha Times',
      'Content',
    ]);
    // The current page is the heading, not a crumb.
    expect(nav).not.toHaveTextContent('Fair opens Friday');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Fair opens Friday' }),
    ).toHaveAttribute('data-shell-page-title');
  });

  it('renders no crumb row without ancestors', () => {
    render(PageHeader, { props: { title: 'Content', crumbs: [] } });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('renders the meta snippet under the title', () => {
    render(PageHeader, {
      props: { title: 'Detail', meta: snippet('<span>Draft</span>') },
    });
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('takes its trail from the shell and reports its title', () => {
    const reports: unknown[] = [];
    const context = new Map([
      [
        Symbol.for('smrt-ui.page-header'),
        {
          crumbs: (parents: { label: string; href: string }[]) => [
            { label: 'Alpha Times', href: '/sites/alpha' },
            ...parents,
          ],
          report: (page: unknown) => {
            reports.push(page);
            return undefined;
          },
        },
      ],
    ]);
    render(PageHeader, {
      props: {
        title: 'Create video',
        parents: [{ label: 'Videos', href: '/sites/alpha/articles/a1/videos' }],
      },
      context,
    });
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Alpha Times',
      'Videos',
    ]);
    flushSync();
    expect(reports).toEqual([
      {
        title: 'Create video',
        parents: [{ label: 'Videos', href: '/sites/alpha/articles/a1/videos' }],
      },
    ]);
  });

  it('renders an editable title inside the h1 and keeps it visible on phones', async () => {
    const { container } = render(PageHeader, {
      props: {
        title: 'Council passes budget',
        titleField: snippet(
          '<input name="title" aria-label="Title" value="Council passes budget" />',
        ),
      },
    });
    const heading = screen.getByRole('heading', { level: 1 });
    const field = screen.getByRole('textbox', { name: 'Title' });
    expect(heading).toContainElement(field);
    // The heading is named by the field's value; the field keeps its label.
    expect(heading).toHaveAccessibleName('Council passes budget');
    // No data-shell-page-title: the shell must not hide the input on phones.
    expect(heading).not.toHaveAttribute('data-shell-page-title');
    expect(heading).toHaveAttribute('data-page-title-field');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    await expectNoA11yViolations(container);
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
