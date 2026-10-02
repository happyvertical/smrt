import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { createControlInteractionRegistry } from '../control-interaction.js';
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
