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
import MultiSelect from '../MultiSelect.svelte';
import Fixture from './multiselect-form.fixture.svelte';

function form() {
  return screen.getByRole('form', { name: 'Roles form' }) as HTMLFormElement;
}
function data() {
  return new FormData(form());
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: /Roles/ }));
}
describe('MultiSelect native form values', () => {
  it('posts repeated values in selection order and removes deselected inputs', async () => {
    render(Fixture);
    await open();
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Operator' }));
    expect(data().getAll('roles')).toEqual(['admin', '42']);
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    expect(data().getAll('roles')).toEqual(['42']);
    await userEvent.click(
      screen.getByRole('option', { name: 'Disabled role' }),
    );
    expect(data().getAll('roles')).toEqual(['42']);
  });
  it('posts canonical numeric selections from legacy strings', () => {
    render(Fixture, { props: { values: ['42'] } });
    expect(data().getAll('roles')).toEqual(['42']);
  });
  it('omits empty selections, empty names and unnamed controls', async () => {
    const { rerender } = render(Fixture);
    expect([...data()]).toEqual([]);
    await rerender({ values: [42], name: '' });
    expect([...data()]).toEqual([]);
    await rerender({ values: [42], unnamed: true });
    expect([...data()]).toEqual([]);
  });
  it.each([
    { disabled: true },
    { fieldsetDisabled: true },
  ])('omits disabled selections %j', (props) => {
    render(Fixture, { props: { ...props, values: [42, 'admin'] } });
    expect([...data()]).toEqual([]);
  });
  it('restores initial selected values on native reset', async () => {
    render(Fixture, { props: { values: [42] } });
    await open();
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    form().reset();
    await settleReset();
    expect(data().getAll('roles')).toEqual(['42']);
    await open();
    expect(screen.getByRole('option', { name: 'Operator' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('option', { name: 'Administrator' }),
    ).toHaveAttribute('aria-selected', 'false');
  });
  it('preserves changed values when reset is canceled', async () => {
    render(Fixture);
    await open();
    await userEvent.click(screen.getByRole('option', { name: 'Operator' }));
    form().addEventListener('reset', (event) => event.preventDefault());
    form().reset();
    await settleReset();
    expect(data().getAll('roles')).toEqual(['42']);
  });
  it('preserves registry identity and posts only applied canonical values', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });
    const identity = { formId: 'roles-form', controlId: 'roles' };
    await registry.execute(
      { action: 'stage', identity, value: ['42', 'admin'] },
      { source: 'agent' },
    );
    expect([...data()]).toEqual([]);
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );
    expect(data().getAll('roles')).toEqual(['42', 'admin']);
    expect(registry.get(identity)?.state.value).toEqual([42, 'admin']);
  });
});

async function settleReset() {
  await new Promise<void>((resolve) => setTimeout(resolve));
  await tick();
}

describe('MultiSelect deferred native reset', () => {
  it('preserves a newer programmatic value before reset completion', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const view = render(MultiSelect, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'other', label: 'Other' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        values: [42],
      },
    });
    await view.rerender({ values: ['changed'] });
    target.reset();
    await view.rerender({ values: ['other'] });
    await settleReset();
    expect(new FormData(target).getAll('choice')).toEqual(['other']);
    await view.unmount();
    target.remove();
  });
  it('cancels pending completion when unmounted', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const onChange = vi.fn();
    const view = render(MultiSelect, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'other', label: 'Other' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        values: [42],
        onvalueschange: onChange,
      },
    });
    target.reset();
    await view.unmount();
    await settleReset();
    expect(onChange).not.toHaveBeenCalled();
    target.remove();
  });
});

describe('MultiSelect selected disabled option posting', () => {
  it('omits initially disabled selections and responds to dynamic disable without losing state', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const options = [
      { value: 42, label: 'Selected', disabled: true },
      { value: 'other', label: 'Other' },
    ];
    const view = render(MultiSelect, {
      target,
      props: {
        options,
        label: 'Choice',
        name: 'choice',
        values: [42, 'other'],
      },
    });
    expect(new FormData(target).getAll('choice')).toEqual(['other']);
    await view.rerender({
      options: options.map((option) => ({ ...option, disabled: false })),
    });
    expect(new FormData(target).getAll('choice')).toEqual(['42', 'other']);
    await view.rerender({ options });
    expect(new FormData(target).getAll('choice')).toEqual(['other']);
    await view.rerender({
      options: options.map((option) => ({ ...option, disabled: false })),
    });
    expect(new FormData(target).getAll('choice')).toEqual(['42', 'other']);
    await view.unmount();
    target.remove();
  });
});

describe('MultiSelect reset listener ordering', () => {
  it('honors cancellation from a later listener microtask', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const onChange = vi.fn();
    const view = render(MultiSelect, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        values: [42],
        onvalueschange: onChange,
      },
    });
    await view.rerender({ values: ['changed'] });
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

describe('MultiSelect reset registry currency', () => {
  it.each([
    false,
    true,
  ])('keeps staged proposal currency correct when cancellation is %s', async (cancel) => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { ...{ values: [42] }, registry } });
    const identity = { formId: 'roles-form', controlId: 'roles' };
    const target = form() as HTMLFormElement;
    await open();
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    expect(
      (
        await registry.execute(
          { action: 'stage', identity, value: ['admin'] },
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
      expect(new FormData(target).getAll('roles')).toEqual(['42']);
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
    render(Fixture, { props: { ...{ values: [42] }, registry } });
    const identity = { formId: 'roles-form', controlId: 'roles' };
    const target = form() as HTMLFormElement;
    await open();
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
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
    expect(new FormData(target).getAll('roles')).toEqual(cancel ? [] : ['42']);
  });
});
