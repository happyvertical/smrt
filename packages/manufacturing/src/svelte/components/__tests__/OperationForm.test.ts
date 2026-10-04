// @vitest-environment jsdom
/**
 * Component coverage for OperationForm via the shared harness: add and edit
 * fields, onsubmit values, required-field validation, category suggestions,
 * and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import OperationForm from '../OperationForm.svelte';

const existing = {
  code: 'WELD',
  name: 'Welding',
  category: 'fabrication',
  requiredQualificationId: 'qual-1',
};

describe('OperationForm', () => {
  it('renders empty add fields', () => {
    render(OperationForm, { props: { onsubmit: vi.fn() } });
    expect(screen.getByLabelText(/Code/)).toHaveValue('');
    expect(screen.getByLabelText(/Code/)).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText(/Name/)).toHaveValue('');
    expect(screen.getByLabelText(/Category/)).toHaveValue('');
    expect(screen.getByLabelText(/Required qualification/)).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Add operation' }),
    ).toBeInTheDocument();
  });

  it('submits trimmed values and does not persist by itself', async () => {
    const onsubmit = vi.fn();
    render(OperationForm, { props: { onsubmit } });
    await userEvent.type(screen.getByLabelText(/Code/), ' CUT ');
    await userEvent.type(screen.getByLabelText(/Name/), ' Cutting ');
    await userEvent.type(screen.getByLabelText(/Category/), 'fabrication');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add operation' }),
    );
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        code: 'CUT',
        name: 'Cutting',
        category: 'fabrication',
        requiredQualificationId: '',
      }),
    );
  });

  it('prefills an edit, locks the code and lets the name change', async () => {
    const onsubmit = vi.fn();
    render(OperationForm, { props: { operation: existing, onsubmit } });
    expect(screen.getByLabelText(/Code/)).toHaveAttribute('readonly');
    expect(screen.getByText('The code cannot be changed.')).toBeInTheDocument();
    const name = screen.getByLabelText(/Name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Structural welding');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        ...existing,
        name: 'Structural welding',
      }),
    );
  });

  it('rejects a missing code and name, tying each message to its field', async () => {
    const onsubmit = vi.fn();
    render(OperationForm, { props: { onsubmit } });
    // Whitespace passes the browser's own `required` check, so the form's does the work.
    await userEvent.type(screen.getByLabelText(/Code/), '   ');
    await userEvent.type(screen.getByLabelText(/Name/), '   ');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add operation' }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    expect(onsubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a code.')).toBeInTheDocument();
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Code/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText(/Name/)).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('error-name'),
    );
  });

  it('offers category suggestions and calls oncancel', async () => {
    const oncancel = vi.fn();
    const { container } = render(OperationForm, {
      props: {
        onsubmit: vi.fn(),
        oncancel,
        categories: ['fabrication', 'finishing'],
      },
    });
    expect(container.querySelectorAll('datalist option')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledOnce();
  });

  it('blocks input while loading', () => {
    render(OperationForm, { props: { onsubmit: vi.fn(), loading: true } });
    expect(screen.getByLabelText(/Name/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('is axe-clean for add, edit and error states', async () => {
    const add = render(OperationForm, {
      props: { onsubmit: vi.fn(), oncancel: vi.fn(), categories: ['x'] },
    });
    await userEvent.type(screen.getByLabelText(/Code/), ' ');
    await userEvent.type(screen.getByLabelText(/Name/), ' ');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add operation' }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    await expectNoA11yViolations(add.container);
    add.unmount();
    const edit = render(OperationForm, {
      props: { operation: existing, onsubmit: vi.fn() },
    });
    await expectNoA11yViolations(edit.container);
  });
});
