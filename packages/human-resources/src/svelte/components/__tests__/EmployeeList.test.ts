// @vitest-environment jsdom
/**
 * Component coverage for EmployeeList via the shared S11 harness (#1416):
 * rendering from props, status labels, the last day employed, the empty state, `onselect`, and
 * accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { EmployeeView } from '../../types.js';
import EmployeeList from '../EmployeeList.svelte';

function employee(overrides: Partial<EmployeeView> = {}): EmployeeView {
  return {
    id: 'emp-1',
    displayName: 'Ada Lovelace',
    employeeNumber: 'E-100',
    position: 'Carpenter',
    workerType: 'apprentice',
    status: 'active',
    startedOn: '2025-04-01',
    ...overrides,
  };
}

describe('EmployeeList', () => {
  it('shows name, employee number, position, worker type, status and start date', () => {
    render(EmployeeList, { props: { employees: [employee()] } });
    const row = screen.getByRole('row', { name: /Ada Lovelace/ });
    expect(
      within(row).getByRole('rowheader', { name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(within(row).getByText('E-100')).toBeInTheDocument();
    expect(within(row).getByText('Carpenter')).toBeInTheDocument();
    expect(within(row).getByText('apprentice')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('2025-04-01')).toBeInTheDocument();
    for (const heading of [
      'Name',
      'Employee number',
      'Position',
      'Worker type',
      'Status',
      'Start date',
    ])
      expect(
        screen.getByRole('columnheader', { name: heading }),
      ).toBeInTheDocument();
  });

  it('labels each employment status in words', () => {
    render(EmployeeList, {
      props: {
        employees: [
          employee({ id: 'a', displayName: 'Ann', status: 'active' }),
          employee({ id: 'b', displayName: 'Bob', status: 'on-leave' }),
          employee({ id: 'c', displayName: 'Cyd', status: 'ended' }),
        ],
      },
    });
    const statusOf = (name: string) =>
      within(screen.getByRole('row', { name: new RegExp(name) }));
    expect(statusOf('Ann').getByText('Active')).toBeInTheDocument();
    expect(statusOf('Bob').getByText('On leave')).toBeInTheDocument();
    expect(statusOf('Cyd').getByText('Ended')).toBeInTheDocument();
  });

  it('shows the last day employed beside the status when an end has been recorded', () => {
    render(EmployeeList, {
      props: {
        employees: [
          employee({ id: 'a', displayName: 'Ann' }),
          employee({ id: 'b', displayName: 'Bob', endsOn: null }),
          employee({
            id: 'c',
            displayName: 'Cyd',
            status: 'ended',
            endsOn: '2026-12-31',
          }),
        ],
      },
    });
    const cyd = within(screen.getByRole('row', { name: /Cyd/ }));
    expect(cyd.getByText('Ended')).toBeInTheDocument();
    expect(cyd.getByText('Last day 2026-12-31')).toBeInTheDocument();
    expect(screen.getAllByText(/Last day/)).toHaveLength(1);
  });

  it('marks a missing position and start date instead of leaving a blank cell', () => {
    render(EmployeeList, {
      props: { employees: [employee({ position: null, startedOn: null })] },
    });
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('shows the default and a custom empty message', () => {
    const { unmount } = render(EmployeeList, { props: { employees: [] } });
    expect(screen.getByText('No employees')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    unmount();
    render(EmployeeList, {
      props: { employees: [], emptyMessage: 'Nobody works here yet' },
    });
    expect(screen.getByText('Nobody works here yet')).toBeInTheDocument();
  });

  it('calls onselect with the employment id', async () => {
    const onselect = vi.fn();
    render(EmployeeList, {
      props: {
        employees: [employee(), employee({ id: 'emp-2', displayName: 'Bob' })],
        onselect,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Open employee: Bob' }),
    );
    expect(onselect).toHaveBeenCalledExactlyOnceWith('emp-2');
  });

  it('renders no buttons without onselect', () => {
    render(EmployeeList, { props: { employees: [employee()] } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(EmployeeList, {
      props: {
        employees: [
          employee(),
          employee({ id: 'emp-2', status: 'ended', position: null }),
          employee({ id: 'emp-3', status: 'ended', endsOn: '2026-12-31' }),
        ],
        onselect: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
