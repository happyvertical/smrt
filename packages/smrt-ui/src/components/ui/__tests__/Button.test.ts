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

  it('appends a custom class while keeping the base button styling (#1589)', () => {
    render(Button, {
      props: { children: textSnippet('Save'), class: 'topic-action-btn' },
    });
    const button = screen.getByRole('button', { name: 'Save' });
    // Caller's class is applied (so custom-styled buttons can adopt Button)...
    expect(button).toHaveClass('topic-action-btn');
    // ...without dropping the primitive's own base/variant styling.
    expect(button).toHaveClass('button');
    expect(button).toHaveClass('primary');
  });

  it('appends a custom class in link mode too', () => {
    render(Button, {
      props: {
        children: textSnippet('Home'),
        href: '/home',
        class: 'nav-link',
      },
    });
    const link = screen.getByRole('link', { name: 'Home' });
    expect(link).toHaveClass('nav-link');
    expect(link).toHaveClass('button');
  });

  it('passes target/rel through to the anchor in link mode (#1589)', () => {
    // External links migrated from `<a target="_blank" rel="...">` to Button
    // must keep their new-tab + opener-isolation semantics on the rendered <a>.
    render(Button, {
      props: {
        children: textSnippet('Open'),
        href: 'https://example.com',
        target: '_blank',
        rel: 'noreferrer',
      },
    });
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('drops anchor-only attrs in button mode (no invalid <button target>) (#1608)', () => {
    // In button mode the anchor-only props must NOT reach the <button> — they
    // are pulled out of `rest` so the runtime matches the "ignored in button
    // mode" doc and never emits invalid HTML.
    render(Button, {
      props: {
        children: textSnippet('Save'),
        target: '_blank',
        rel: 'noreferrer',
      },
    });
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).not.toHaveAttribute('target');
    expect(button).not.toHaveAttribute('rel');
  });

  it('is not navigable when disabled in link mode', async () => {
    const { container } = render(Button, {
      props: { children: textSnippet('Home'), href: '/home', disabled: true },
    });
    // A disabled link-mode Button must be genuinely non-navigable: it drops its
    // href (no navigation target), leaves the tab order, and is announced as
    // disabled. Previously it kept a live href + tab stop and only blocked the
    // mouse via CSS pointer-events, so keyboard/AT users could still activate
    // it (flagged by the PR #1599 auto-review).
    const anchor = container.querySelector('a');
    if (anchor === null)
      throw new Error('expected a rendered <a> in link mode');
    expect(anchor).not.toHaveAttribute('href');
    expect(anchor).toHaveAttribute('tabindex', '-1');
    expect(anchor).toHaveAttribute('aria-disabled', 'true');
    // No href => no implicit link role => not reachable as a link by AT.
    expect(screen.queryByRole('link')).toBeNull();
    // ...and keyboard focus can't land on it, so Enter can't navigate.
    await userEvent.tab();
    expect(anchor).not.toHaveFocus();
    await expectNoA11yViolations(container);
  });

  it('keeps a disabled link non-navigable even when the caller passes tabindex/aria-disabled', async () => {
    const { container } = render(Button, {
      props: {
        children: textSnippet('Home'),
        href: '/home',
        disabled: true,
        // Passthrough props that must NOT win over the disabled semantics:
        // `rest` is spread after the component's own attributes on the <a>.
        tabindex: 0,
        'aria-disabled': false,
      },
    });
    const anchor = container.querySelector('a');
    if (anchor === null)
      throw new Error('expected a rendered <a> in link mode');
    expect(anchor).toHaveAttribute('tabindex', '-1');
    expect(anchor).toHaveAttribute('aria-disabled', 'true');
    expect(anchor).not.toHaveAttribute('href');
    await userEvent.tab();
    expect(anchor).not.toHaveFocus();
    await expectNoA11yViolations(container);
  });

  it('is axe-clean', async () => {
    const { container } = render(Button, {
      props: { children: textSnippet('Accessible') },
    });
    await expectNoA11yViolations(container);
  });
});
