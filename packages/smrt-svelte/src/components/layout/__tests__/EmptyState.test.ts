/**
 * Component tests for the EmptyState layout primitive (Sweep S11, #1416).
 *
 * Asserts the title/description render, the built-in vs. custom-snippet icon,
 * the optional action (link vs. button + onaction callback), the size variant,
 * and axe-clean output.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import EmptyState from '../EmptyState.svelte';

function iconSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span data-testid="custom-icon">${text}</span>`,
  }));
}

describe('EmptyState', () => {
  it('renders the title as a heading', () => {
    render(EmptyState, { props: { title: 'No results' } });
    expect(
      screen.getByRole('heading', { name: 'No results' }),
    ).toBeInTheDocument();
  });

  it('renders the optional description', () => {
    render(EmptyState, {
      props: { title: 'Empty', description: 'Try adjusting your filters.' },
    });
    expect(screen.getByText('Try adjusting your filters.')).toBeInTheDocument();
  });

  it('renders a default built-in icon when icon is a string name', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', icon: 'search' },
    });
    expect(container.querySelector('.icon-container svg')).not.toBeNull();
  });

  it('renders a custom icon snippet', () => {
    render(EmptyState, {
      props: { title: 'Empty', icon: iconSnippet('★') },
    });
    expect(screen.getByTestId('custom-icon')).toHaveTextContent('★');
  });

  it('renders the action as a link when actionHref is set', () => {
    render(EmptyState, {
      props: {
        title: 'Empty',
        actionLabel: 'Create one',
        actionHref: '/new',
      },
    });
    const link = screen.getByRole('link', { name: 'Create one' });
    expect(link).toHaveAttribute('href', '/new');
  });

  it('renders the action as a button and fires onaction when clicked', async () => {
    const onaction = vi.fn();
    render(EmptyState, {
      props: { title: 'Empty', actionLabel: 'Reload', onaction },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onaction).toHaveBeenCalledTimes(1);
  });

  it('renders no action control when no actionLabel is provided', () => {
    render(EmptyState, { props: { title: 'Empty' } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('applies the size variant class', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', size: 'sm' },
    });
    expect(container.querySelector('.empty-state')).toHaveClass('sm');
  });

  it('is axe-clean with a description and button action', async () => {
    const { container } = render(EmptyState, {
      props: {
        title: 'Nothing here yet',
        description: 'Add your first item to get started.',
        actionLabel: 'Add item',
        onaction: () => {},
      },
    });
    await expectNoA11yViolations(container);
  });
});
