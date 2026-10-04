// @vitest-environment jsdom
/**
 * Component coverage for OperationList via the shared harness: rendering from
 * props, status labels, the empty state, select/retire/reinstate callbacks,
 * and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { OperationView } from '../../types.js';
import OperationList from '../OperationList.svelte';

function operation(overrides: Partial<OperationView> = {}): OperationView {
  return {
    id: 'op-1',
    code: 'WELD',
    name: 'Welding',
    category: 'fabrication',
    isActive: true,
    ...overrides,
  };
}

describe('OperationList', () => {
  it('shows code, name, category and status with column headings', () => {
    render(OperationList, { props: { operations: [operation()] } });
    const row = screen.getByRole('row', { name: /Welding/ });
    expect(
      within(row).getByRole('rowheader', { name: 'WELD' }),
    ).toBeInTheDocument();
    expect(within(row).getByText('Welding')).toBeInTheDocument();
    expect(within(row).getByText('fabrication')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    for (const heading of ['Code', 'Name', 'Category', 'Status'])
      expect(
        screen.getByRole('columnheader', { name: heading }),
      ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Actions' }),
    ).not.toBeInTheDocument();
  });

  it('keeps a retired operation in the list, labelled in words', () => {
    render(OperationList, {
      props: {
        operations: [
          operation(),
          operation({
            id: 'op-2',
            code: 'OLD',
            name: 'Old press',
            isActive: false,
            category: '',
          }),
        ],
      },
    });
    const old = within(screen.getByRole('row', { name: /Old press/ }));
    expect(old.getByText('Retired')).toBeInTheDocument();
    expect(old.getByText('None')).toBeInTheDocument();
  });

  it('shows the default and a custom empty message', () => {
    const { unmount } = render(OperationList, { props: { operations: [] } });
    expect(screen.getByText('No operations')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    unmount();
    render(OperationList, {
      props: { operations: [], emptyMessage: 'Nothing here yet' },
    });
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('calls onselect with the operation id', async () => {
    const onselect = vi.fn();
    render(OperationList, {
      props: {
        operations: [
          operation(),
          operation({ id: 'op-2', code: 'CUT', name: 'Cutting' }),
        ],
        onselect,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit operation: Cutting' }),
    );
    expect(onselect).toHaveBeenCalledExactlyOnceWith('op-2');
  });

  it('offers retire on an active operation and reinstate on a retired one', async () => {
    const onretire = vi.fn();
    const onreinstate = vi.fn();
    render(OperationList, {
      props: {
        operations: [
          operation(),
          operation({
            id: 'op-2',
            code: 'OLD',
            name: 'Old press',
            isActive: false,
          }),
        ],
        onretire,
        onreinstate,
      },
    });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await userEvent.click(
      screen.getByRole('button', { name: 'Retire operation: Welding' }),
    );
    expect(onretire).toHaveBeenCalledExactlyOnceWith('op-1');
    await userEvent.click(
      screen.getByRole('button', { name: 'Reinstate operation: Old press' }),
    );
    expect(onreinstate).toHaveBeenCalledExactlyOnceWith('op-2');
    expect(
      screen.queryByRole('button', { name: 'Retire operation: Old press' }),
    ).not.toBeInTheDocument();
  });

  it('renders no buttons without callbacks', () => {
    render(OperationList, { props: { operations: [operation()] } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(OperationList, {
      props: {
        operations: [
          operation(),
          operation({ id: 'op-2', isActive: false, category: '' }),
        ],
        onselect: vi.fn(),
        onretire: vi.fn(),
        onreinstate: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
