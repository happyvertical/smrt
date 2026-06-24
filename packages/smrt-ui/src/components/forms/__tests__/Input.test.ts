/**
 * Golden test for Input (Sweep L4, #1423).
 *
 * Input is the low-level form primitive: a bare <input> whose accessible name
 * comes from a wrapping label/FormGroup, not from itself. Programmatic-label +
 * axe-clean coverage for the form primitives is L1's deliverable (#1420, "with
 * L4"); here we cover render + interaction + state behavior.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Input from '../Input.svelte';

describe('Input', () => {
  it('renders an <input> with the given id/name/type', () => {
    render(Input, { props: { id: 'first', name: 'first', type: 'text' } });
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('id', 'first');
    expect(input).toHaveAttribute('name', 'first');
    expect(input).toHaveAttribute('type', 'text');
  });

  it('accepts typed input', async () => {
    render(Input, { props: { id: 'q', name: 'q' } });
    const input = screen.getByRole<HTMLInputElement>('textbox');
    await userEvent.type(input, 'hello');
    expect(input).toHaveValue('hello');
  });

  it('renders the placeholder', () => {
    render(Input, { props: { id: 'q', placeholder: 'Search…' } });
    expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument();
  });

  it('does not accept input when disabled', async () => {
    render(Input, { props: { id: 'q', disabled: true } });
    const input = screen.getByRole<HTMLInputElement>('textbox');
    expect(input).toBeDisabled();
    await userEvent.type(input, 'nope');
    expect(input).toHaveValue('');
  });

  it('is read-only when readonly is set', async () => {
    render(Input, { props: { id: 'q', readonly: true, value: 'fixed' } });
    const input = screen.getByRole<HTMLInputElement>('textbox');
    expect(input).toHaveAttribute('readonly');
    await userEvent.type(input, 'x');
    expect(input).toHaveValue('fixed');
  });

  it('marks required inputs', () => {
    render(Input, { props: { id: 'q', required: true } });
    expect(screen.getByRole('textbox')).toBeRequired();
  });
});
