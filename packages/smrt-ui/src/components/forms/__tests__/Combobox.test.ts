import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import Fixture from './combobox-labels.fixture.svelte';

const towns = [
  { value: '0b9c-uuid-lacombe', label: 'Lacombe' },
  { value: '77aa-uuid-blackfalds', label: 'Blackfalds' },
  { value: '12cd-uuid-ponoka', label: 'Ponoka' },
];

describe('Combobox labels and reopening', () => {
  it('shows the option label on first render, never the raw id', () => {
    render(Fixture, {
      props: { options: towns, value: '77aa-uuid-blackfalds' },
    });
    expect(screen.getByRole('combobox', { name: 'Town' })).toHaveValue(
      'Blackfalds',
    );
  });

  it('shows valueLabel (or nothing) until async options arrive, then the label', async () => {
    const view = render(Fixture, {
      props: { options: [], value: '12cd-uuid-ponoka', valueLabel: 'Ponoka' },
    });
    const input = screen.getByRole('combobox', { name: 'Town' });
    expect(input).toHaveValue('Ponoka');

    await view.rerender({
      options: [],
      value: '12cd-uuid-ponoka',
      valueLabel: undefined,
    });
    await tick();
    expect(input).toHaveValue('');
    expect(input).not.toHaveValue('12cd-uuid-ponoka');

    await view.rerender({ options: towns, value: '12cd-uuid-ponoka' });
    await tick();
    expect(input).toHaveValue('Ponoka');
  });

  it('reopening after a choice lists every option, not only the current one', async () => {
    render(Fixture, { props: { options: towns, value: '' } });
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
    render(Fixture, {
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
});
