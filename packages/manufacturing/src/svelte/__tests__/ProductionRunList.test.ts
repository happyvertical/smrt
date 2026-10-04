// @vitest-environment jsdom
/**
 * ProductionRunList: target, completed and status per run, reporting a
 * completion through the host's handler (with the quantity checked against
 * what is left), the host's failure, closed runs, and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ProductionRunList from '../components/ProductionRunList.svelte';
import {
  type ProductionRunView,
  toProductionRunView,
  validateCompletionQty,
} from '../types.js';

function run(overrides: Partial<ProductionRunView> = {}): ProductionRunView {
  return {
    id: 'run-1',
    label: 'Frame',
    targetQty: 25,
    completedQty: 12,
    status: 'in_progress',
    ...overrides,
  };
}

describe('ProductionRunList', () => {
  it('shows progress and status for each run', () => {
    render(ProductionRunList, {
      props: {
        runs: [
          run(),
          run({
            id: 'run-2',
            label: 'Gate',
            completedQty: 4,
            targetQty: 4,
            status: 'done',
          }),
        ],
      },
    });
    const frame = within(screen.getByRole('row', { name: /Frame/ }));
    expect(frame.getByRole('rowheader', { name: 'Frame' })).toBeInTheDocument();
    const bar = frame.getByRole('progressbar', { name: '12 of 25 done' });
    expect(bar).toHaveAttribute('aria-valuenow', '12');
    expect(bar).toHaveAttribute('aria-valuemax', '25');
    expect(frame.getByText('In progress')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /Gate/ })).getByText('Done'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Report completion' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('shows the default and a custom empty message', () => {
    const { unmount } = render(ProductionRunList, { props: { runs: [] } });
    expect(screen.getByText('No production runs')).toBeInTheDocument();
    unmount();
    render(ProductionRunList, {
      props: { runs: [], emptyMessage: 'Nothing on the floor' },
    });
    expect(screen.getByText('Nothing on the floor')).toBeInTheDocument();
  });

  it('reports a completion on an open run and clears the field', async () => {
    const oncomplete = vi.fn(() => true);
    render(ProductionRunList, { props: { runs: [run()], oncomplete } });
    const field = screen.getByRole('spinbutton', {
      name: 'Quantity completed for Frame',
    });
    await userEvent.type(field, '3.5');
    await userEvent.click(
      screen.getByRole('button', { name: 'Report a completion for Frame' }),
    );
    expect(oncomplete).toHaveBeenCalledWith('run-1', 3.5);
    expect(field).toHaveValue(null);
  });

  it('refuses an empty, zero or too-large quantity without calling the host', async () => {
    const oncomplete = vi.fn();
    render(ProductionRunList, { props: { runs: [run()], oncomplete } });
    const field = screen.getByRole('spinbutton', {
      name: 'Quantity completed for Frame',
    });
    const submit = screen.getByRole('button', {
      name: 'Report a completion for Frame',
    });
    await userEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a quantity greater than zero.',
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(field, '14');
    await userEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Only 13 left to build.',
    );
    expect(oncomplete).not.toHaveBeenCalled();
  });

  it("keeps the quantity and says so when the host's handler fails", async () => {
    const oncomplete = vi.fn(() => {
      throw new Error('stock');
    });
    render(ProductionRunList, { props: { runs: [run()], oncomplete } });
    const field = screen.getByRole('spinbutton', {
      name: 'Quantity completed for Frame',
    });
    await userEvent.type(field, '2');
    await userEvent.click(
      screen.getByRole('button', { name: 'Report a completion for Frame' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The completion could not be recorded.',
    );
    expect(field).toHaveValue(2);
  });

  it('offers no reporting on a done or cancelled run', () => {
    render(ProductionRunList, {
      props: {
        runs: [
          run({ status: 'done' }),
          run({ id: 'run-2', label: 'Gate', status: 'cancelled' }),
        ],
        oncomplete: vi.fn(),
      },
    });
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('adapts a run and checks a quantity the same way the list does', () => {
    expect(
      toProductionRunView(
        {
          id: 'r',
          targetQty: 25,
          completedQty: 12,
          status: 'planned',
        } as never,
        'Frame',
      ),
    ).toEqual({
      id: 'r',
      label: 'Frame',
      targetQty: 25,
      completedQty: 12,
      status: 'planned',
    });
    const view = run({ targetQty: 0.3, completedQty: 0.1 });
    expect(validateCompletionQty('0.2', view)).toEqual({ ok: true, qty: 0.2 });
    expect(validateCompletionQty('0.3', view)).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(validateCompletionQty(' ', view)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const large = run({ targetQty: 1_000_000_000, completedQty: 0 });
    expect(validateCompletionQty('1000000001', large)).toEqual({
      ok: false,
      reason: 'too_many',
    });
  });

  it('has no accessibility violations, with reporting and an error shown', async () => {
    const { container } = render(ProductionRunList, {
      props: {
        runs: [run(), run({ id: 'run-2', label: 'Gate', status: 'done' })],
        oncomplete: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
    await userEvent.click(
      screen.getByRole('button', { name: 'Report a completion for Frame' }),
    );
    await expectNoA11yViolations(container);
  });
});
