// @vitest-environment jsdom
/**
 * AssemblyForm: add and edit fields, onsubmit values, validation messages,
 * the default-operation picker (active operations, a retired or unknown
 * current value), hidden and read-only fields, and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssemblyForm from '../components/AssemblyForm.svelte';
import type { AssemblyFormInitial, OperationView } from '../types.js';

const existing: AssemblyFormInitial = {
  name: 'Frame',
  description: 'Welded base frame',
  category: 'structural',
  partReference: 'DWG-1001',
  price: 125050,
  estimatedLabourMinutes: 95,
  defaultOperationId: 'op-weld',
  tags: ['steel', 'frame'],
};

function operation(
  id: string,
  code: string,
  name: string,
  isActive = true,
): OperationView {
  return { id, code, name, category: '', isActive };
}

const operations = [
  operation('op-cut', 'CUT', 'Cutting'),
  operation('op-weld', 'WELD', 'Welding'),
  operation('op-old', 'OLD', 'Old process', false),
];

describe('AssemblyForm', () => {
  it('keeps untouched fields exactly as stored: negative price, comma tag', async () => {
    const odd: AssemblyFormInitial = {
      ...existing,
      price: -123,
      tags: ['steel, frame', 'steel'],
    };
    const onsubmit = vi.fn();
    render(AssemblyForm, { props: { assembly: odd, onsubmit, operations } });
    await userEvent.type(screen.getByLabelText(/Name/), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        ...odd,
        name: 'Frame!',
      }),
    );
  });

  it('shows and rejects a negative price once the reader edits it', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: { assembly: { ...existing, price: -123 }, onsubmit, operations },
    });
    expect(screen.getByLabelText('Price')).toHaveValue('-1.23');
    await userEvent.type(screen.getByLabelText('Price'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('uses the currency exponent for the price: JPY has none, KWD three', async () => {
    const onsubmit = vi.fn();
    const jpy = render(AssemblyForm, {
      props: {
        assembly: { ...existing, price: 1300 },
        onsubmit,
        operations,
        currency: 'JPY',
      },
    });
    expect(screen.getByLabelText('Price')).toHaveValue('1300');
    const price = screen.getByLabelText('Price');
    await userEvent.clear(price);
    await userEvent.type(price, '1500');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledWith(
        expect.objectContaining({ price: 1500 }),
      ),
    );
    jpy.unmount();
    const kwd = vi.fn();
    render(AssemblyForm, {
      props: { onsubmit: kwd, operations, currency: 'KWD' },
    });
    const field = screen.getByLabelText('Price');
    expect(field).toHaveValue('0.000');
    await userEvent.clear(field);
    await userEvent.type(field, '1.234');
    await userEvent.type(screen.getByLabelText(/Name/), 'Gate');
    await userEvent.click(screen.getByRole('button', { name: 'Add assembly' }));
    await vi.waitFor(() =>
      expect(kwd).toHaveBeenCalledWith(
        expect.objectContaining({ price: 1234 }),
      ),
    );
  });

  it('passes hidden and read-only values through exactly as stored', async () => {
    const odd: AssemblyFormInitial = {
      ...existing,
      name: ' Frame ',
      description: '  padded  ',
      tags: ['steel, coated', ' lone '],
    };
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: {
        assembly: odd,
        onsubmit,
        operations,
        hiddenFields: ['tags'],
        readonlyFields: ['description', 'name'],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith(odd),
    );
  });

  it('renders empty add fields', () => {
    render(AssemblyForm, { props: { onsubmit: vi.fn(), operations } });
    expect(screen.getByLabelText(/Name/)).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Part reference')).toHaveValue('');
    expect(screen.getByLabelText('Category')).toHaveValue('');
    expect(screen.getByLabelText('Price')).toHaveValue('0.00');
    expect(screen.getByLabelText('Estimated labour (minutes)')).toHaveValue(
      '0',
    );
    expect(screen.getByLabelText('Default operation')).toHaveValue('');
    expect(screen.getByLabelText('Tags')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Add assembly' }),
    ).toBeInTheDocument();
  });

  it('submits trimmed, converted values for a new assembly', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, { props: { onsubmit, operations } });
    await userEvent.type(screen.getByLabelText(/Name/), ' Gate ');
    await userEvent.type(screen.getByLabelText('Description'), 'Swing gate');
    await userEvent.type(screen.getByLabelText('Part reference'), ' G-7 ');
    await userEvent.clear(screen.getByLabelText('Price'));
    await userEvent.type(screen.getByLabelText('Price'), '1250.5');
    await userEvent.clear(screen.getByLabelText('Estimated labour (minutes)'));
    await userEvent.type(
      screen.getByLabelText('Estimated labour (minutes)'),
      '120',
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Default operation'),
      'op-cut',
    );
    await userEvent.type(screen.getByLabelText('Tags'), 'steel, , gate,steel');
    await userEvent.click(screen.getByRole('button', { name: 'Add assembly' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        name: 'Gate',
        description: 'Swing gate',
        category: '',
        partReference: 'G-7',
        price: 125050,
        estimatedLabourMinutes: 120,
        defaultOperationId: 'op-cut',
        tags: ['steel', 'gate'],
      }),
    );
  });

  it('prefills an edit and submits the changed name', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: { assembly: existing, onsubmit, operations },
    });
    expect(screen.getByLabelText('Price')).toHaveValue('1250.50');
    expect(screen.getByLabelText('Tags')).toHaveValue('steel, frame');
    expect(screen.getByLabelText('Default operation')).toHaveValue('op-weld');
    const name = screen.getByLabelText(/Name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Base frame');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        ...existing,
        name: 'Base frame',
        tags: ['steel', 'frame'],
      }),
    );
  });

  it('rejects a missing name, a bad price and a fractional labour estimate', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, { props: { onsubmit, operations } });
    // Whitespace passes the browser's own `required` check.
    await userEvent.type(screen.getByLabelText(/Name/), '   ');
    await userEvent.clear(screen.getByLabelText('Price'));
    await userEvent.type(screen.getByLabelText('Price'), '1.234');
    await userEvent.clear(screen.getByLabelText('Estimated labour (minutes)'));
    await userEvent.type(
      screen.getByLabelText('Estimated labour (minutes)'),
      '1.5',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add assembly' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    expect(onsubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Enter a price of zero or more, with no more decimals than the currency has.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Enter a whole number of minutes, zero or more.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Price')).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('error-price'),
    );
    expect(screen.getByLabelText('Estimated labour (minutes)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('refuses a negative labour estimate', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: { assembly: existing, onsubmit, operations },
    });
    const labour = screen.getByLabelText('Estimated labour (minutes)');
    await userEvent.clear(labour);
    await userEvent.type(labour, '-5');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(
        screen.getByText('Enter a whole number of minutes, zero or more.'),
      ).toBeInTheDocument(),
    );
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('offers only active operations for a new assembly', () => {
    render(AssemblyForm, { props: { onsubmit: vi.fn(), operations } });
    const options = Array.from(
      screen.getByLabelText('Default operation').querySelectorAll('option'),
    ).map((option) => option.textContent?.trim());
    expect(options).toEqual(['None', 'CUT - Cutting', 'WELD - Welding']);
  });

  it('keeps a retired current operation visible, marked, and clearable', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: {
        assembly: { ...existing, defaultOperationId: 'op-old' },
        onsubmit,
        operations,
      },
    });
    const picker = screen.getByLabelText('Default operation');
    expect(picker).toHaveValue('op-old');
    expect(
      screen.getByRole('option', { name: 'OLD - Old process (retired)' }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(picker, '');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledWith(
        expect.objectContaining({ defaultOperationId: null }),
      ),
    );
  });

  it('keeps a current operation the host did not list, marked unknown', () => {
    render(AssemblyForm, {
      props: {
        assembly: { ...existing, defaultOperationId: 'op-gone' },
        onsubmit: vi.fn(),
        operations,
      },
    });
    expect(screen.getByLabelText('Default operation')).toHaveValue('op-gone');
    expect(
      screen.getByRole('option', { name: 'Unknown operation (op-gone)' }),
    ).toBeInTheDocument();
  });

  it('leaves out hidden fields and passes their initial values through', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: {
        assembly: existing,
        onsubmit,
        operations,
        hiddenFields: ['price', 'tags'],
      },
    });
    expect(screen.queryByLabelText('Price')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tags')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith(existing),
    );
  });

  it('renders read-only fields that cannot change and are not checked', async () => {
    const onsubmit = vi.fn();
    render(AssemblyForm, {
      props: {
        assembly: existing,
        onsubmit,
        operations,
        readonlyFields: ['price', 'defaultOperationId', 'description'],
      },
    });
    expect(screen.getByLabelText('Price')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Description')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Default operation')).toBeDisabled();
    expect(screen.getByLabelText(/Name/)).not.toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith(existing),
    );
  });

  it('calls oncancel and blocks input while loading', async () => {
    const oncancel = vi.fn();
    const first = render(AssemblyForm, {
      props: { onsubmit: vi.fn(), oncancel, operations },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledOnce();
    first.unmount();
    render(AssemblyForm, {
      props: { onsubmit: vi.fn(), operations, loading: true },
    });
    expect(screen.getByLabelText(/Name/)).toBeDisabled();
    expect(screen.getByLabelText('Default operation')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('is axe-clean for add, edit, retired, read-only and error states', async () => {
    const add = render(AssemblyForm, {
      props: { onsubmit: vi.fn(), oncancel: vi.fn(), operations },
    });
    await userEvent.type(screen.getByLabelText(/Name/), ' ');
    await userEvent.click(screen.getByRole('button', { name: 'Add assembly' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    await expectNoA11yViolations(add.container);
    add.unmount();
    const edit = render(AssemblyForm, {
      props: {
        assembly: { ...existing, defaultOperationId: 'op-old' },
        onsubmit: vi.fn(),
        operations,
        readonlyFields: ['price'],
        hiddenFields: ['tags'],
      },
    });
    await expectNoA11yViolations(edit.container);
  });
});
