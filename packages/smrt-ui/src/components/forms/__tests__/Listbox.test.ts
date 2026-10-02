import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  type ControlCommand,
  type ControlInteractionRegistry,
  createControlInteractionRegistry,
  executeLocalControlCommand,
} from '../control-interaction.js';
import Listbox from '../Listbox.svelte';
import Fixture from './listbox-form.fixture.svelte';

function form() {
  return screen.getByRole('form', { name: 'Vendor form' }) as HTMLFormElement;
}
function data() {
  return new FormData(form());
}
describe('Listbox native form value', () => {
  it('posts one option value after mouse or keyboard selection', async () => {
    render(Fixture);
    await userEvent.click(
      screen.getByRole('option', { name: 'Plate supplier' }),
    );
    expect(data().getAll('vendor')).toEqual(['42']);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(data().getAll('vendor')).toEqual(['steel']);
    await userEvent.click(
      screen.getByRole('option', { name: 'Disabled supplier' }),
    );
    expect(data().getAll('vendor')).toEqual(['steel']);
  });
  it('posts an empty named selection and omits missing or empty names', async () => {
    const { rerender } = render(Fixture);
    expect(data().getAll('vendor')).toEqual(['']);
    await rerender({ name: '', value: 42 });
    expect([...data()]).toEqual([]);
    await rerender({ unnamed: true, value: 42 });
    expect([...data()]).toEqual([]);
  });
  it.each([
    { disabled: true },
    { fieldsetDisabled: true },
  ])('omits disabled values %j', (props) => {
    render(Fixture, { props: { ...props, value: 42 } });
    expect([...data()]).toEqual([]);
  });
  it.each([
    undefined,
    42,
  ])('restores initial value %j and selection on reset', async (value) => {
    render(Fixture, { props: { value } });
    await userEvent.click(
      screen.getByRole('option', { name: 'Steel supplier' }),
    );
    form().reset();
    await settleReset();
    expect(data().getAll('vendor')).toEqual([value === undefined ? '' : '42']);
    expect(
      screen.getByRole('option', { name: 'Plate supplier' }),
    ).toHaveAttribute('aria-selected', String(value === 42));
    expect(
      screen.getByRole('option', { name: 'Steel supplier' }),
    ).toHaveAttribute('aria-selected', 'false');
  });
  it('retains the selected value when reset is canceled', async () => {
    render(Fixture);
    await userEvent.click(
      screen.getByRole('option', { name: 'Plate supplier' }),
    );
    form().addEventListener('reset', (event) => event.preventDefault());
    form().reset();
    await settleReset();
    expect(data().getAll('vendor')).toEqual(['42']);
  });
  it('preserves registry identity and posts only applied values', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });
    const identity = { formId: 'vendor-form', controlId: 'vendor' };
    await registry.execute(
      { action: 'stage', identity, value: '42' },
      { source: 'agent' },
    );
    expect(data().getAll('vendor')).toEqual(['']);
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );
    expect(data().getAll('vendor')).toEqual(['42']);
    expect(registry.get(identity)?.state.value).toBe(42);
  });
});

async function settleReset() {
  await new Promise<void>((resolve) => setTimeout(resolve));
  await tick();
}

describe('Listbox deferred native reset', () => {
  it('preserves a newer programmatic value before reset completion', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const view = render(Listbox, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'other', label: 'Other' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        value: 42,
      },
    });
    await view.rerender({ value: 'changed' });
    target.reset();
    await view.rerender({ value: 'other' });
    await settleReset();
    expect(new FormData(target).getAll('choice')).toEqual(['other']);
    await view.unmount();
    target.remove();
  });
  it('cancels pending completion when unmounted', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const onChange = vi.fn();
    const view = render(Listbox, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'other', label: 'Other' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        value: 42,
        onvaluechange: onChange,
      },
    });
    target.reset();
    await view.unmount();
    await settleReset();
    expect(onChange).not.toHaveBeenCalled();
    target.remove();
  });
});

describe('Listbox selected disabled option posting', () => {
  it('omits initially disabled selections and responds to dynamic disable without losing state', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const options = [
      { value: 42, label: 'Selected', disabled: true },
      { value: 'other', label: 'Other' },
    ];
    const view = render(Listbox, {
      target,
      props: { options, label: 'Choice', name: 'choice', value: 42 },
    });
    expect(new FormData(target).getAll('choice')).toEqual([]);
    await view.rerender({
      options: options.map((option) => ({ ...option, disabled: false })),
    });
    expect(new FormData(target).getAll('choice')).toEqual(['42']);
    await view.rerender({ options });
    expect(new FormData(target).getAll('choice')).toEqual([]);
    await view.rerender({
      options: options.map((option) => ({ ...option, disabled: false })),
    });
    expect(new FormData(target).getAll('choice')).toEqual(['42']);
    await view.unmount();
    target.remove();
  });
});

describe('Listbox reset listener ordering', () => {
  it('honors cancellation from a later listener microtask', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const onChange = vi.fn();
    const view = render(Listbox, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        value: 42,
        onvaluechange: onChange,
      },
    });
    await view.rerender({ value: 'changed' });
    target.addEventListener('reset', (event) => {
      queueMicrotask(() => event.preventDefault());
    });
    target.reset();
    await settleReset();
    expect(new FormData(target).getAll('choice')).toEqual(['changed']);
    expect(onChange).not.toHaveBeenCalled();
    await view.unmount();
    target.remove();
  });
});

function dispatchLocalCommand(
  registry: ControlInteractionRegistry,
  command: ControlCommand,
) {
  const target = new EventTarget();
  let pending: ReturnType<typeof executeLocalControlCommand> | undefined;
  target.addEventListener(
    'click',
    (event) => {
      pending = executeLocalControlCommand(registry, command, event);
    },
    { once: true },
  );
  target.dispatchEvent(new Event('click'));
  if (!pending) throw new Error('local command handler did not run');
  return pending;
}

describe('Listbox reset registry currency', () => {
  it.each([
    false,
    true,
  ])('keeps staged proposal currency correct when cancellation is %s', async (cancel) => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { ...{ value: 42 }, registry } });
    const identity = { formId: 'vendor-form', controlId: 'vendor' };
    const target = form() as HTMLFormElement;
    await userEvent.click(
      screen.getByRole('option', { name: 'Steel supplier' }),
    );
    expect(
      (
        await registry.execute(
          { action: 'stage', identity, value: 42 },
          { source: 'agent' },
        )
      ).ok,
    ).toBe(true);
    if (cancel)
      target.addEventListener('reset', (event) => event.preventDefault());
    target.reset();
    await settleReset();
    expect(registry.get(identity)?.state.staged?.stale).toBe(!cancel);
    const applied = await dispatchLocalCommand(registry, {
      action: 'apply',
      identity,
    });
    expect(applied.ok).toBe(cancel);
    if (!cancel) {
      expect(applied.reason).toBe('staged_value_stale');
      expect(new FormData(target).getAll('vendor')).toEqual(['42']);
    }
  });

  it.each([
    false,
    true,
  ])('preserves reset over an async local clear when cancellation is %s', async (cancel) => {
    let releasePolicy!: () => void;
    let policyStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const started = new Promise<void>((resolve) => {
      policyStarted = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
      policy: async (command) => {
        if (command.action === 'clear') {
          policyStarted();
          await blocked;
        }
        return { allowed: true };
      },
    });
    render(Fixture, { props: { ...{ value: 42 }, registry } });
    const identity = { formId: 'vendor-form', controlId: 'vendor' };
    const target = form() as HTMLFormElement;
    await userEvent.click(
      screen.getByRole('option', { name: 'Steel supplier' }),
    );
    const clearing = dispatchLocalCommand(registry, {
      action: 'clear',
      identity,
    });
    await started;
    if (cancel)
      target.addEventListener('reset', (event) => event.preventDefault());
    target.reset();
    await settleReset();
    releasePolicy();
    const result = await clearing;
    await tick();
    expect(result.ok).toBe(cancel);
    if (!cancel) expect(result.reason).toBe('staged_value_stale');
    expect(new FormData(target).getAll('vendor')).toEqual(
      cancel ? [''] : ['42'],
    );
  });
});

describe('Listbox exact option identity posting', () => {
  it.each([
    false,
    true,
  ])('posts an enabled numeric option beside a disabled string collision in reversed order %s', async (reverse) => {
    const target = document.createElement('form');
    document.body.append(target);
    const options = [
      { value: 42, label: 'Numeric' },
      { value: '42', label: 'Text', disabled: true },
    ];
    if (reverse) options.reverse();
    const view = render(Listbox, {
      target,
      props: { options, label: 'Choice', name: 'choice', value: 42 },
    });
    expect(new FormData(target).getAll('choice')).toEqual(['42']);
    expect(screen.getByRole('option', { name: 'Numeric' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await view.rerender({ value: undefined });
    await userEvent.click(screen.getByRole('option', { name: 'Numeric' }));
    expect(new FormData(target).getAll('choice')).toEqual(['42']);
    expect(screen.getByRole('option', { name: 'Numeric' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await view.rerender({
      value: 42,
      options: options.map((option) => ({
        ...option,
        disabled: option.value === 42,
      })),
    });
    expect(new FormData(target).getAll('choice')).toEqual([]);
    await userEvent.click(screen.getByRole('option', { name: 'Text' }));
    expect(new FormData(target).getAll('choice')).toEqual(['42']);
    expect(screen.getByRole('option', { name: 'Text' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await view.unmount();
    target.remove();
  });
});
