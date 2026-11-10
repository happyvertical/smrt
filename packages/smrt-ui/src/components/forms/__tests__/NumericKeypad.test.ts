/**
 * NumericKeypad: entry, ranges, money minor units, hardware keys, native post
 * (smrt#3463).
 */
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y.js';
import NumericKeypad from '../NumericKeypad.svelte';

const key = (name: string) => screen.getByRole('button', { name });
const display = () => screen.getByRole('status', { name: 'Entered amount' });
const root = (container: HTMLElement) =>
  container.querySelector(
    '[data-smrt-component="NumericKeypad"]',
  ) as HTMLElement;

async function tap(...names: string[]) {
  for (const name of names) await fireEvent.click(key(name));
}

describe('NumericKeypad', () => {
  it('lays out digits, backspace and clear with labelled keys', async () => {
    const { container } = render(NumericKeypad);
    for (const digit of '0123456789') expect(key(digit)).toBeEnabled();
    expect(key('Delete last character')).toBeInTheDocument();
    expect(key('Clear')).toBeInTheDocument();
    // Integer mode: no decimal point key and no confirm key without onSubmit.
    expect(screen.queryByRole('button', { name: 'Decimal point' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(root(container)).toHaveAttribute('role', 'group');
    expect(display()).toHaveAttribute('aria-live', 'polite');
    await expectNoA11yViolations(container);
  });

  it('types, backspaces and clears, reporting each change', async () => {
    const onChange = vi.fn();
    render(NumericKeypad, { props: { onChange } });
    await tap('1', '2', '5');
    expect(display()).toHaveTextContent('125');
    expect(onChange).toHaveBeenLastCalledWith({
      text: '125',
      number: 125,
      minorUnits: null,
      valid: true,
    });
    await tap('Delete last character');
    expect(display()).toHaveTextContent('12');
    await tap('Clear');
    expect(display()).toHaveTextContent('0');
    expect(onChange).toHaveBeenLastCalledWith({
      text: '',
      number: null,
      minorUnits: null,
      valid: false,
    });
  });

  it('shows the decimal key only when decimals are allowed and caps them', async () => {
    render(NumericKeypad, { props: { maxDecimals: 2 } });
    await tap('Decimal point', '5', '2', '5', 'Decimal point');
    expect(display()).toHaveTextContent('0.52');
  });

  it('flags a value outside min/max and blocks confirm', async () => {
    const onSubmit = vi.fn();
    const { container } = render(NumericKeypad, {
      props: { min: 5, max: 20, onSubmit },
    });
    await tap('1');
    expect(root(container)).toHaveAttribute('data-state', 'below');
    expect(screen.getByText('Must be at least 5.')).toBeInTheDocument();
    expect(key('Confirm')).toBeDisabled();
    await tap('5');
    expect(root(container)).toHaveAttribute('data-state', 'ok');
    expect(key('Confirm')).toBeEnabled();
    await tap('0');
    expect(root(container)).toHaveAttribute('data-state', 'above');
    expect(screen.getByText('Must be at most 20.')).toBeInTheDocument();
    await fireEvent.click(key('Confirm'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clampToMax refuses a press that would exceed max', async () => {
    render(NumericKeypad, { props: { max: 20, clampToMax: true } });
    await tap('2', '5');
    expect(display()).toHaveTextContent('2');
    await tap('0');
    expect(display()).toHaveTextContent('20');
  });

  it('submits through the confirm key with a custom label', async () => {
    const onSubmit = vi.fn();
    render(NumericKeypad, { props: { onSubmit, submitLabel: 'Add to cart' } });
    expect(key('Add to cart')).toBeDisabled();
    await tap('7');
    await fireEvent.click(key('Add to cart'));
    expect(onSubmit).toHaveBeenCalledWith({
      text: '7',
      number: 7,
      minorUnits: null,
      valid: true,
    });
  });

  it('money mode follows the currency exponent and reports integer minor units', async () => {
    const onChange = vi.fn();
    render(NumericKeypad, {
      props: { mode: 'money', currency: 'USD', prefix: '$', onChange },
    });
    await tap('1', '9', 'Decimal point', '9', '9', '1');
    expect(display()).toHaveTextContent(/\$\s*19\.99/);
    expect(onChange).toHaveBeenLastCalledWith({
      text: '19.99',
      number: 19.99,
      minorUnits: 1999,
      valid: true,
    });
  });

  it('money mode with a zero-decimal currency has no point', () => {
    render(NumericKeypad, { props: { mode: 'money', currency: 'JPY' } });
    expect(screen.queryByRole('button', { name: 'Decimal point' })).toBeNull();
  });

  it('blocks money that cannot be represented as safe integer minor units', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { container } = render(NumericKeypad, {
      props: { mode: 'money', maxLength: 20, onChange, onSubmit },
    });
    await tap(...'99999999999999');
    expect(root(container)).toHaveAttribute('data-state', 'invalid');
    expect(key('Confirm')).toBeDisabled();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ minorUnits: null, valid: false }),
    );
    await fireEvent.keyDown(root(container), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    await tap('Delete last character');
    expect(root(container)).toHaveAttribute('data-state', 'ok');
    expect(key('Confirm')).toBeEnabled();
    await fireEvent.click(key('Confirm'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ minorUnits: 999999999999900, valid: true }),
    );
  });

  it('accepts an initial numeric value', () => {
    render(NumericKeypad, { props: { value: 42, unit: 'pcs' } });
    expect(display()).toHaveTextContent('42');
    expect(display()).toHaveTextContent('pcs');
  });

  it('takes hardware keys: digits, both separators, Backspace, Delete, Enter', async () => {
    const onSubmit = vi.fn();
    const { container } = render(NumericKeypad, {
      props: { maxDecimals: 2, onSubmit },
    });
    const pad = root(container);
    await fireEvent.keyDown(pad, { key: '4' });
    await fireEvent.keyDown(pad, { key: ',' });
    await fireEvent.keyDown(pad, { key: '5' });
    expect(display()).toHaveTextContent('4.5');
    await fireEvent.keyDown(pad, { key: 'Backspace' });
    expect(display()).toHaveTextContent('4.');
    await fireEvent.keyDown(pad, { key: '.' });
    expect(display()).toHaveTextContent('4.');
    await fireEvent.keyDown(pad, { key: 'a' });
    await fireEvent.keyDown(pad, { key: '3', ctrlKey: true });
    expect(display()).toHaveTextContent('4.');
    await fireEvent.keyDown(pad, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(pad, { key: 'Delete' });
    expect(display()).toHaveTextContent('0');
  });

  it('Enter on a focused key does not also confirm', async () => {
    const onSubmit = vi.fn();
    render(NumericKeypad, { props: { onSubmit } });
    await tap('3');
    await fireEvent.keyDown(key('3'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled ignores clicks and keys', async () => {
    const onChange = vi.fn();
    const { container } = render(NumericKeypad, {
      props: { disabled: true, onChange },
    });
    expect(key('5')).toBeDisabled();
    await fireEvent.keyDown(root(container), { key: '5' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('posts the typed text natively, and minor units in money mode', async () => {
    const form = document.body.appendChild(document.createElement('form'));
    render(NumericKeypad, {
      target: form,
      props: { name: 'qty', value: '12' },
    });
    expect(new FormData(form).get('qty')).toBe('12');
    form.remove();

    const moneyForm = document.body.appendChild(document.createElement('form'));
    render(NumericKeypad, {
      target: moneyForm,
      props: { name: 'price', mode: 'money', currency: 'USD', value: '12.5' },
    });
    expect(new FormData(moneyForm).get('price')).toBe('1250');
    moneyForm.remove();
  });

  it('applies label overrides', () => {
    render(NumericKeypad, {
      props: { labels: { clear: 'Reset', region: 'Quantity pad' } },
    });
    expect(key('Reset')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Quantity pad' }),
    ).toBeInTheDocument();
  });
});
