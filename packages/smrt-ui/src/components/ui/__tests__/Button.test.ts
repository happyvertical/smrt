/**
 * Golden test for Button (Sweep L4, #1423).
 *
 * The reference pattern for component tests in this package: render via Testing
 * Library, assert role/name/state, drive interaction with user-event, and prove
 * the rendered output is axe-clean. New primitive tests should mirror this shape.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Button from '../Button.svelte';

/** Build a text Snippet for the Button's `children` prop. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Button', () => {
  it('renders children as a <button> with type=button by default', () => {
    render(Button, { props: { children: textSnippet('Save') } });
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('type', 'button');
  });

  it('fires onclick when clicked', async () => {
    const onclick = vi.fn();
    render(Button, { props: { children: textSnippet('Go'), onclick } });
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('is keyboard-activatable when focused', async () => {
    const onclick = vi.fn();
    render(Button, { props: { children: textSnippet('Go'), onclick } });
    const button = screen.getByRole('button', { name: 'Go' });
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onclick).toHaveBeenCalled();
  });

  it('does not fire onclick when disabled', async () => {
    const onclick = vi.fn();
    render(Button, {
      props: { children: textSnippet('Go'), disabled: true, onclick },
    });
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onclick).not.toHaveBeenCalled();
  });

  it('reflects loading as aria-busy and disables interaction', () => {
    render(Button, { props: { children: textSnippet('Go'), loading: true } });
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
  });

  it('renders as a link (role=link) when href is provided', () => {
    render(Button, {
      props: { children: textSnippet('Home'), href: '/home' },
    });
    const link = screen.getByRole('link', { name: 'Home' });
    expect(link).toHaveAttribute('href', '/home');
  });

  it('is axe-clean', async () => {
    const { container } = render(Button, {
      props: { children: textSnippet('Accessible') },
    });
    await expectNoA11yViolations(container);
  });
});
