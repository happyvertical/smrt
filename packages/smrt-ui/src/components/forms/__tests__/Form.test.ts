/**
 * Golden test for the Provider-free Form primitive (#1589 deferred-forms phase).
 *
 * Form is the leaf `<form>` wrapper domain packages adopt instead of raw markup:
 * it forwards native attributes, renders children, and (by default) prevents the
 * native submit so the consumer's `onsubmit` runs without a page navigation.
 */

import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Form from '../Form.svelte';

const children = createRawSnippet(() => ({
  render: () => '<button type="submit">Save</button>',
}));

describe('Form', () => {
  it('renders a <form> with forwarded attributes and its children', () => {
    const { container } = render(Form, {
      props: { name: 'profile', class: 'profile-form', children },
    });
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute('name', 'profile');
    expect(form).toHaveClass('form', 'profile-form');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('prevents the native submit and calls onsubmit by default', async () => {
    const onsubmit = vi.fn();
    render(Form, { props: { onsubmit, children } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenCalledTimes(1);
    const event = onsubmit.mock.calls[0][0] as SubmitEvent;
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves native submission intact when preventDefault is false', async () => {
    const onsubmit = vi.fn();
    render(Form, { props: { onsubmit, preventDefault: false, children } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenCalledTimes(1);
    expect((onsubmit.mock.calls[0][0] as SubmitEvent).defaultPrevented).toBe(
      false,
    );
  });

  it('is axe-clean', async () => {
    const { container } = render(Form, {
      props: { 'aria-label': 'Profile form', children },
    });
    await expectNoA11yViolations(container);
  });
});
