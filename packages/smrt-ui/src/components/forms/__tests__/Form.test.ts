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
import {
  createControlInteractionRegistry,
  executeLocalControlCommand,
} from '../control-interaction.js';
import Form from '../Form.svelte';
import FormAttachmentFixture from './form-attachment.fixture.svelte';

const children = createRawSnippet(() => ({
  render: () => '<button type="submit">Save</button>',
}));

const controlledInput = createRawSnippet(() => ({
  render: () => '<input data-smrt-control="display-name" />',
}));

function dispatchTrusted(target: EventTarget, type: string): void {
  const event = new Event(type, { bubbles: true });
  const implementationSymbol = Object.getOwnPropertySymbols(event).find(
    (symbol) => symbol.description === 'impl',
  );
  if (!implementationSymbol) throw new Error('missing JSDOM event internals');
  target.addEventListener(
    type,
    (dispatched) => {
      const implementation = (
        dispatched as Event & Record<symbol, { isTrusted: boolean }>
      )[implementationSymbol];
      implementation.isTrusted = true;
    },
    { capture: true, once: true },
  );
  target.dispatchEvent(event);
}

function dispatchLocalGesture<T>(
  execute: (event: Event) => Promise<T>,
): Promise<T> {
  const target = new EventTarget();
  let pending: Promise<T> | undefined;
  target.addEventListener(
    'click',
    (event) => {
      pending = execute(event);
    },
    { once: true },
  );
  target.dispatchEvent(new Event('click'));
  if (!pending) throw new Error('local gesture handler did not run');
  return pending;
}

describe('Form', () => {
  it('exposes its native element while mounted and clears it on unmount', async () => {
    const { component, container, unmount } = render(Form, {
      props: { children },
    });
    expect(component.getFormElement()).toBe(container.querySelector('form'));
    await unmount();
    expect(component.getFormElement()).toBeNull();
  });

  it('forwards an action attachment and preserves form posting and control registration', async () => {
    const registry = createControlInteractionRegistry();
    const attached = vi.fn();
    const destroyed = vi.fn();
    const submitted = vi.fn();
    const onsubmit = vi.fn();
    const enhance = (form: HTMLFormElement) => {
      attached(form);
      const submit = (event: SubmitEvent) => {
        submitted(event.defaultPrevented, new FormData(form));
        event.preventDefault();
      };
      form.addEventListener('submit', submit);
      return {
        destroy() {
          form.removeEventListener('submit', submit);
          destroyed();
        },
      };
    };
    const { container, unmount } = render(FormAttachmentFixture, {
      props: { enhance, registry, onsubmit },
    });
    const form = container.querySelector('form');
    expect(attached).toHaveBeenCalledExactlyOnceWith(form);
    expect(form).toHaveAttribute('method', 'POST');
    expect(form).toHaveAttribute('action', '/profile');
    expect(registry.list()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted.mock.calls[0][0]).toBe(false);
    expect(submitted.mock.calls[0][1].get('displayName')).toBe('Dana');
    expect(onsubmit).toHaveBeenCalledOnce();
    await unmount();
    expect(destroyed).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(0);
  });

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

  it('records trusted value edits but not focus-only clicks', () => {
    const registry = createControlInteractionRegistry();
    const recordUserEdit = vi.spyOn(registry, 'recordUserEdit');
    const { container } = render(Form, {
      props: {
        formId: 'profile',
        interactionRegistry: registry,
        children: controlledInput,
      },
    });
    const input = container.querySelector('input');
    if (!input) throw new Error('Expected controlled input');

    // A click can focus a field without changing it. Direct-edit tracking is
    // deliberately limited to input/change, while composite controls record
    // their successful mutations explicitly.
    dispatchTrusted(input, 'click');
    expect(recordUserEdit).not.toHaveBeenCalled();

    dispatchTrusted(input, 'input');
    expect(recordUserEdit).toHaveBeenCalledOnce();
    expect(recordUserEdit).toHaveBeenCalledWith({
      formId: 'profile',
      controlId: 'display-name',
      subject: undefined,
    });
  });

  it('preserves a consumer-normalized human edit while an async setter rolls back', async () => {
    let releaseSetter: (() => void) | undefined;
    let setterStarted: (() => void) | undefined;
    const setterBlocked = new Promise<void>((resolve) => {
      releaseSetter = resolve;
    });
    const setterStartedPromise = new Promise<void>((resolve) => {
      setterStarted = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const { container } = render(Form, {
      props: {
        formId: 'profile',
        interactionRegistry: registry,
        children: controlledInput,
        oninput: (event) => {
          const input = event.target as HTMLInputElement;
          input.value = input.value.replace(/^./, (character) =>
            character.toUpperCase(),
          );
        },
      },
    });
    const input = container.querySelector('input');
    if (!input) throw new Error('Expected controlled input');
    const identity = { formId: 'profile', controlId: 'display-name' };

    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => input.value,
      setValue: async (next) => {
        input.value = String(next);
        setterStarted?.();
        await setterBlocked;
        throw new Error('setter_failed');
      },
      restoreValue: (next) => {
        input.value = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = dispatchLocalGesture((event) =>
      executeLocalControlCommand(
        registry,
        { action: 'apply', identity, revision: 1 },
        event,
      ),
    );
    await setterStartedPromise;

    input.value = 'katherine';
    dispatchTrusted(input, 'input');
    expect(input.value).toBe('Katherine');
    releaseSetter?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'setter_failed',
    });
    expect(input.value).toBe('Katherine');
  });

  it('is axe-clean', async () => {
    const { container } = render(Form, {
      props: { 'aria-label': 'Profile form', children },
    });
    await expectNoA11yViolations(container);
  });
});
