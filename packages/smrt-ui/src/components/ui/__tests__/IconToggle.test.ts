import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import IconToggle from '../IconToggle.svelte';

const icon = createRawSnippet(() => ({
  render: () => '<svg viewBox="0 0 24 24" width="18" height="18"></svg>',
}));

describe('IconToggle', () => {
  it('is a labelled toggle button reflecting pressed', () => {
    render(IconToggle, {
      props: { label: 'Grid', pressed: true, children: icon },
    });
    const button = screen.getByRole('button', { name: 'Grid' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('shows a count badge that is part of the name and the tooltip', () => {
    render(IconToggle, {
      props: { label: 'Draft', count: 12, children: icon },
    });
    const button = screen.getByRole('button', { name: 'Draft (12)' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Draft (12)');
    expect(button.querySelector('.count')).toHaveTextContent('12');
  });

  it('keeps no state of its own: it calls onclick and the owner decides', async () => {
    const onclick = vi.fn();
    render(IconToggle, {
      props: { label: 'Cards', pressed: false, onclick, children: icon },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(onclick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('is axe-clean', async () => {
    const { container } = render(IconToggle, {
      props: { label: 'Grid', count: 3, children: icon },
    });
    await expectNoA11yViolations(container);
  });
});
