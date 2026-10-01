import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createControlInteractionRegistry } from '../control-interaction.js';
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
    await tick();
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
    await tick();
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
