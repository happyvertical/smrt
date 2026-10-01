import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createControlInteractionRegistry } from '../control-interaction.js';
import Fixture from './combobox-form.fixture.svelte';

function data() {
  return new FormData(
    screen.getByRole('form', { name: 'Order' }) as HTMLFormElement,
  );
}
async function selectPlate() {
  await userEvent.click(screen.getByRole('combobox', { name: 'SKU' }));
  await userEvent.click(screen.getByRole('option', { name: 'Plate 1/4 A36' }));
}

describe('Combobox native form value', () => {
  it('posts the selected value once, retaining it while searching', async () => {
    render(Fixture);
    await selectPlate();
    expect(data().getAll('sku')).toEqual(['42']);
    const input = screen.getByRole('combobox', { name: 'SKU' });
    expect(input).not.toHaveAttribute('name');
    await userEvent.clear(input);
    await userEvent.type(input, 'unselected search');
    expect(data().getAll('sku')).toEqual(['42']);
  });
  it('posts keyboard-selected and custom values', async () => {
    render(Fixture, { props: { allowCustom: true } });
    const input = screen.getByRole('combobox', { name: 'SKU' });
    await userEvent.type(input, 'Plate');
    await userEvent.keyboard('{Enter}');
    expect(data().getAll('sku')).toEqual(['42']);
    await userEvent.clear(input);
    await userEvent.type(input, 'custom');
    expect(data().getAll('sku')).toEqual(['custom']);
  });
  it('posts an empty named value and omits missing or empty names', async () => {
    const { rerender } = render(Fixture);
    expect(data().getAll('sku')).toEqual(['']);
    await rerender({ name: '' });
    expect([...data()]).toEqual([]);
    await rerender({ unnamed: true });
    expect([...data()]).toEqual([]);
  });
  it.each([
    { disabled: true },
    { fieldsetDisabled: true },
  ])('omits disabled values: %j', (props) => {
    render(Fixture, { props: { ...props, value: '42' } });
    expect([...data()]).toEqual([]);
  });
  it('does not select disabled options', async () => {
    render(Fixture);
    await userEvent.click(screen.getByRole('combobox', { name: 'SKU' }));
    await userEvent.click(
      screen.getByRole('option', { name: 'Disabled plate' }),
    );
    expect(data().getAll('sku')).toEqual(['']);
  });
  it.each([
    '',
    '42',
  ])('restores initial selection %j on native reset', async (value) => {
    render(Fixture, { props: { value, allowCustom: true } });
    const input = screen.getByRole('combobox', { name: 'SKU' });
    await userEvent.clear(input);
    await userEvent.type(input, 'changed');
    (screen.getByRole('form', { name: 'Order' }) as HTMLFormElement).reset();
    await tick();
    expect(data().getAll('sku')).toEqual([value]);
    expect(input).toHaveValue(value ? 'Plate 1/4 A36' : '');
  });
  it('preserves selection when reset is canceled', async () => {
    render(Fixture);
    await selectPlate();
    const form = screen.getByRole('form', { name: 'Order' });
    form.addEventListener('reset', (event) => event.preventDefault());
    await fireEvent.reset(form);
    await tick();
    expect(data().getAll('sku')).toEqual(['42']);
  });
  it('posts registry-applied values while preserving identity and staged isolation', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'order', controlId: 'sku' },
        value: '42',
      },
      { source: 'agent' },
    );
    expect(data().getAll('sku')).toEqual(['']);
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );
    expect(data().getAll('sku')).toEqual(['42']);
    expect(
      registry.get({ formId: 'order', controlId: 'sku' })?.state.value,
    ).toBe('42');
  });
});
