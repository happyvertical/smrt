import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Combobox from '../Combobox.svelte';
import { createControlInteractionRegistry } from '../control-interaction.js';
import FormFixture from './combobox-form.fixture.svelte';
import LabelsFixture from './combobox-labels.fixture.svelte';

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
    render(FormFixture);
    await selectPlate();
    expect(data().getAll('sku')).toEqual(['42']);
    const input = screen.getByRole('combobox', { name: 'SKU' });
    expect(input).not.toHaveAttribute('name');
    await userEvent.clear(input);
    await userEvent.type(input, 'unselected search');
    expect(data().getAll('sku')).toEqual(['42']);
  });
  it('posts keyboard-selected and custom values', async () => {
    render(FormFixture, { props: { allowCustom: true } });
    const input = screen.getByRole('combobox', { name: 'SKU' });
    await userEvent.type(input, 'Plate');
    await userEvent.keyboard('{Enter}');
    expect(data().getAll('sku')).toEqual(['42']);
    await userEvent.clear(input);
    await userEvent.type(input, 'custom');
    expect(data().getAll('sku')).toEqual(['custom']);
  });
  it('posts an empty named value and omits missing or empty names', async () => {
    const { rerender } = render(FormFixture);
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
    render(FormFixture, { props: { ...props, value: '42' } });
    expect([...data()]).toEqual([]);
  });
  it('does not select disabled options', async () => {
    render(FormFixture);
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
    render(FormFixture, { props: { value, allowCustom: true } });
    const input = screen.getByRole('combobox', { name: 'SKU' });
    await userEvent.clear(input);
    await userEvent.type(input, 'changed');
    (screen.getByRole('form', { name: 'Order' }) as HTMLFormElement).reset();
    await settleReset();
    expect(data().getAll('sku')).toEqual([value]);
    expect(input).toHaveValue(value ? 'Plate 1/4 A36' : '');
  });
  it('preserves selection when reset is canceled', async () => {
    render(FormFixture);
    await selectPlate();
    const form = screen.getByRole('form', { name: 'Order' });
    form.addEventListener('reset', (event) => event.preventDefault());
    await fireEvent.reset(form);
    await settleReset();
    expect(data().getAll('sku')).toEqual(['42']);
  });
  it('posts registry-applied values while preserving identity and staged isolation', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormFixture, { props: { registry } });
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

const towns = [
  { value: '0b9c-uuid-lacombe', label: 'Lacombe' },
  { value: '77aa-uuid-blackfalds', label: 'Blackfalds' },
  { value: '12cd-uuid-ponoka', label: 'Ponoka' },
];

describe('Combobox labels and reopening', () => {
  it('shows the option label on first render, never the raw id', () => {
    render(LabelsFixture, {
      props: { options: towns, value: '77aa-uuid-blackfalds' },
    });
    expect(screen.getByRole('combobox', { name: 'Town' })).toHaveValue(
      'Blackfalds',
    );
  });

  it('shows valueLabel (or nothing) until async options arrive, then the label', async () => {
    const view = render(LabelsFixture, {
      props: { options: [], value: '12cd-uuid-ponoka', valueLabel: 'Ponoka' },
    });
    const input = screen.getByRole('combobox', { name: 'Town' });
    expect(input).toHaveValue('Ponoka');

    await view.rerender({
      options: [],
      value: '12cd-uuid-ponoka',
      valueLabel: undefined,
    });
    await settleReset();
    expect(input).toHaveValue('');
    expect(input).not.toHaveValue('12cd-uuid-ponoka');

    await view.rerender({ options: towns, value: '12cd-uuid-ponoka' });
    await settleReset();
    expect(input).toHaveValue('Ponoka');
  });

  it('reopening after a choice lists every option, not only the current one', async () => {
    render(LabelsFixture, { props: { options: towns, value: '' } });
    const input = screen.getByRole('combobox', { name: 'Town' });
    await userEvent.type(input, 'lacom');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: 'Lacombe' }));
    expect(screen.getByTestId('value')).toHaveTextContent('0b9c-uuid-lacombe');
    expect(input).toHaveValue('Lacombe');

    await userEvent.click(document.body);
    await userEvent.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: 'Lacombe' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('puts the chosen label back when the person leaves without choosing', async () => {
    render(LabelsFixture, {
      props: { options: towns, value: '77aa-uuid-blackfalds' },
    });
    const input = screen.getByRole('combobox', { name: 'Town' });
    await userEvent.clear(input);
    await userEvent.type(input, 'pon');
    await userEvent.keyboard('{Escape}');
    expect(input).toHaveValue('Blackfalds');
    expect(screen.getByTestId('value')).toHaveTextContent(
      '77aa-uuid-blackfalds',
    );
  });

  it('posts the committed id under its name, not the visible label', async () => {
    const { container } = render(LabelsFixture, {
      props: { options: towns, value: '77aa-uuid-blackfalds' },
    });
    const input = screen.getByRole('combobox', { name: 'Town' });
    expect(input).not.toHaveAttribute('name');
    const posted = container.querySelectorAll('input[name="town"]');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveValue('77aa-uuid-blackfalds');

    await userEvent.click(input);
    await userEvent.click(screen.getByRole('option', { name: 'Ponoka' }));
    expect(container.querySelector('input[name="town"]')).toHaveValue(
      '12cd-uuid-ponoka',
    );
  });

  it('a required combobox is valid while its value is committed, even before its option loads', async () => {
    const view = render(LabelsFixture, {
      props: { options: [], value: '12cd-uuid-ponoka', required: true },
    });
    const input = screen.getByRole('combobox', {
      name: 'Town',
    }) as HTMLInputElement;
    expect(input).toHaveValue('');
    expect(input.checkValidity()).toBe(true);
    expect(input).toHaveAttribute('aria-required', 'true');

    await view.rerender({ options: towns, value: '', required: true });
    await settleReset();
    expect(input.checkValidity()).toBe(false);
  });
});

async function settleReset() {
  await new Promise<void>((resolve) => setTimeout(resolve));
  await tick();
}

describe('Combobox deferred native reset', () => {
  it('preserves a newer programmatic value before reset completion', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const view = render(Combobox, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'other', label: 'Other' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        value: '42',
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
    const view = render(Combobox, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'other', label: 'Other' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        value: '42',
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

describe('Combobox reset listener ordering', () => {
  it('honors cancellation from a later listener microtask', async () => {
    const target = document.createElement('form');
    document.body.append(target);
    const onChange = vi.fn();
    const view = render(Combobox, {
      target,
      props: {
        options: [
          { value: 42, label: 'Initial' },
          { value: 'changed', label: 'Changed' },
        ],
        label: 'Choice',
        name: 'choice',
        value: '42',
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
