// @vitest-environment jsdom
/**
 * AssemblyList: rendering from props, the field policy dropping hidden
 * columns, the empty state, `onselect`, and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssemblyList from '../components/AssemblyList.svelte';
import { assemblyPolicy, assemblyView } from './fixtures.js';

describe('AssemblyList', () => {
  it('shows name, part reference, SKU, price, labour and bill version', () => {
    render(AssemblyList, { props: { assemblies: [assemblyView()] } });
    const row = within(screen.getByRole('row', { name: /Frame/ }));
    expect(row.getByRole('rowheader', { name: 'Frame' })).toBeInTheDocument();
    expect(row.getByText('DWG-1001')).toBeInTheDocument();
    expect(row.getByText('FR-100')).toBeInTheDocument();
    expect(row.getByText(/1,250\.00/)).toBeInTheDocument();
    expect(row.getByText('1 h 35 min')).toBeInTheDocument();
    expect(row.getByText('Version 3')).toBeInTheDocument();
    for (const heading of [
      'Name',
      'Part reference',
      'SKU',
      'Price',
      'Labour',
      'Bill of materials',
    ])
      expect(
        screen.getByRole('columnheader', { name: heading }),
      ).toBeInTheDocument();
  });

  it('says plainly when a value is missing', () => {
    render(AssemblyList, {
      props: {
        assemblies: [
          assemblyView({
            partReference: '',
            skuCodes: [],
            estimatedLabourMinutes: 0,
            activeBomVersion: null,
          }),
          assemblyView({
            id: 'asm-2',
            name: 'Bracket',
            estimatedLabourMinutes: 40,
          }),
        ],
      },
    });
    const frame = within(screen.getByRole('row', { name: /Frame/ }));
    expect(frame.getAllByText('None')).toHaveLength(2);
    expect(frame.getByText('Not estimated')).toBeInTheDocument();
    expect(frame.getByText('No active bill')).toBeInTheDocument();
    const bracket = within(screen.getByRole('row', { name: /Bracket/ }));
    expect(bracket.getByText('40 min')).toBeInTheDocument();
  });

  it('drops the columns the field policy hides', () => {
    render(AssemblyList, {
      props: {
        assemblies: [assemblyView()],
        policy: assemblyPolicy({ price: 'hidden', partReference: 'hidden' }),
      },
    });
    expect(
      screen.queryByRole('columnheader', { name: 'Price' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/1,250\.00/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Part reference' }),
    ).not.toBeInTheDocument();
    // Computed columns are not policy fields and stay.
    expect(
      screen.getByRole('columnheader', { name: 'SKU' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Labour' }),
    ).toBeInTheDocument();
  });

  it('keeps advanced fields visible in the list', () => {
    render(AssemblyList, {
      props: {
        assemblies: [assemblyView()],
        policy: assemblyPolicy({ price: 'advanced' }),
      },
    });
    expect(
      screen.getByRole('columnheader', { name: 'Price' }),
    ).toBeInTheDocument();
  });

  it('shows the default and a custom empty message', () => {
    const { unmount } = render(AssemblyList, { props: { assemblies: [] } });
    expect(screen.getByText('No assemblies')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    unmount();
    render(AssemblyList, {
      props: { assemblies: [], emptyMessage: 'Nothing is made here yet' },
    });
    expect(screen.getByText('Nothing is made here yet')).toBeInTheDocument();
  });

  it('calls onselect with the assembly id, and renders no buttons without it', async () => {
    const onselect = vi.fn();
    const { unmount } = render(AssemblyList, {
      props: {
        assemblies: [
          assemblyView(),
          assemblyView({ id: 'asm-2', name: 'Bracket' }),
        ],
        onselect,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Open assembly: Bracket' }),
    );
    expect(onselect).toHaveBeenCalledExactlyOnceWith('asm-2');
    unmount();
    render(AssemblyList, { props: { assemblies: [assemblyView()] } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(AssemblyList, {
      props: {
        assemblies: [
          assemblyView(),
          assemblyView({
            id: 'asm-2',
            partReference: '',
            activeBomVersion: null,
          }),
        ],
        onselect: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
