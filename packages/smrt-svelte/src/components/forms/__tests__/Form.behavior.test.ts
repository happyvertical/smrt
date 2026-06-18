/**
 * Deep behavior tests for Form (Sweep S11, #1416).
 *
 * The shallow golden test (Form.test.ts) only covers the <form> element, child
 * rendering, the onsubmit contract, and axe. This suite exercises the real
 * value-collection logic: Form registers child fields through its context, and
 * on submit it walks every registered field's getValue() to build the data
 * object. We mount Form via an inline fixture that nests TextInput +
 * NumberInput so the registration → collection → onsubmit pipeline runs for
 * real (no mocked field logic).
 *
 * Form depends on the Provider-backed useAppState/useSTT hooks (they throw
 * outside a <Provider>), so both are mocked to non-listening stubs — the
 * reference pattern from Form.test.ts.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    lastResult: '',
    isReady: false,
    adapterType: null,
    isInitializing: false,
    downloadProgress: 0,
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import Form from '../Form.svelte';
import FormWithFields from './form-with-fields.fixture.svelte';

function submitButton() {
  return createRawSnippet(() => ({
    render: () => `<button type="submit">Submit</button>`,
  }));
}

describe('Form — submit value collection', () => {
  it('collects each registered field value into the onsubmit data object', async () => {
    const onsubmit = vi.fn();
    render(FormWithFields, {
      props: { onsubmit, textValue: 'Ada Lovelace', numberValue: 36 },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onsubmit).toHaveBeenCalledTimes(1);
    expect(onsubmit).toHaveBeenCalledWith({
      fullname: 'Ada Lovelace',
      age: 36,
    });
  });

  it('reflects live typing into the collected submit data', async () => {
    const onsubmit = vi.fn();
    render(FormWithFields, { props: { onsubmit } });

    await userEvent.type(screen.getByLabelText('Full name'), 'Grace');
    await userEvent.type(screen.getByLabelText('Age'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onsubmit).toHaveBeenCalledWith({ fullname: 'Grace', age: 50 });
  });

  it('prevents native submission when an onsubmit handler is provided', async () => {
    const onsubmit = vi.fn();
    const { container } = render(FormWithFields, { props: { onsubmit } });
    const form = container.querySelector('form');
    expect(form).toBeInTheDocument();

    const submitEvent = new Event('submit', {
      bubbles: true,
      cancelable: true,
    });
    (form as HTMLFormElement).dispatchEvent(submitEvent);

    expect(onsubmit).toHaveBeenCalledTimes(1);
    expect(submitEvent.defaultPrevented).toBe(true);
  });

  it('does NOT prevent native submission when no onsubmit handler is set', () => {
    const { container } = render(FormWithFields, { props: {} });
    const form = container.querySelector('form') as HTMLFormElement;

    const submitEvent = new Event('submit', {
      bubbles: true,
      cancelable: true,
    });
    form.dispatchEvent(submitEvent);

    // Native submission left intact for SvelteKit form actions / use:enhance.
    expect(submitEvent.defaultPrevented).toBe(false);
  });

  it('drops a field from the collected data once it unmounts (unregister)', async () => {
    const onsubmit = vi.fn();
    const { rerender } = render(FormWithFields, {
      props: { onsubmit, textValue: 'Keep', numberValue: 7, showAge: true },
    });

    // Both fields registered → both collected.
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onsubmit).toHaveBeenLastCalledWith({ fullname: 'Keep', age: 7 });

    // Unmount the age field; Form.unregisterField drops it from the next submit.
    await rerender({
      onsubmit,
      textValue: 'Keep',
      numberValue: 7,
      showAge: false,
    });
    expect(screen.queryByLabelText('Age')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onsubmit).toHaveBeenLastCalledWith({ fullname: 'Keep' });
  });
});

describe('Form — native form attributes', () => {
  it('forwards method and action onto the <form> element', () => {
    const { container } = render(Form, {
      props: { children: submitButton(), method: 'POST', action: '/save' },
    });
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form).toHaveAttribute('method', 'POST');
    expect(form).toHaveAttribute('action', '/save');
  });

  it('submits empty data when no fields are registered', async () => {
    const onsubmit = vi.fn();
    render(Form, { props: { children: submitButton(), onsubmit } });
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onsubmit).toHaveBeenCalledWith({});
  });
});

describe('Form — status region & a11y', () => {
  it('renders a polite, visually-hidden status region', () => {
    render(Form, { props: { children: submitButton() } });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('is axe-clean with nested labelled fields', async () => {
    const { container } = render(FormWithFields, {
      props: { onsubmit: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
