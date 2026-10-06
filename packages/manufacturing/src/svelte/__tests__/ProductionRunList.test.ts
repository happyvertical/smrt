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
  validateTargetQty,
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

  it('shows what is left at six decimals', async () => {
    render(ProductionRunList, {
      props: {
        runs: [run({ targetQty: 0.3, completedQty: 0.1 })],
        oncomplete: vi.fn(),
      },
    });
    await userEvent.type(
      screen.getByRole('spinbutton', { name: 'Quantity completed for Frame' }),
      '0.25',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Report a completion for Frame' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Only 0.2 left to build.',
    );
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
    const large = run({ targetQty: 999_999_999, completedQty: 999_999_998 });
    expect(validateCompletionQty('1.000001', large)).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(validateCompletionQty('0.001', large)).toEqual({
      ok: true,
      qty: 0.001,
    });
    expect(validateCompletionQty('1000000000', large)).toEqual({
      ok: false,
      reason: 'invalid',
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

describe('ProductionRunList management controls', () => {
  it('renders no management column or control without a handler', () => {
    render(ProductionRunList, { props: { runs: [run()] } });
    expect(
      screen.queryByRole('columnheader', { name: 'Manage run' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Finish|Cancel/ })).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('renders only the controls whose handler is given, on open runs only', () => {
    render(ProductionRunList, {
      props: {
        runs: [run(), run({ id: 'run-2', label: 'Gate', status: 'done' })],
        onfinish: vi.fn(),
      },
    });
    expect(
      screen.getByRole('button', { name: 'Finish Frame' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel Frame' })).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish Gate' })).toBeNull();
  });

  it('sets a target through the handler with the run and the number', async () => {
    const onsettarget = vi.fn(() => true);
    render(ProductionRunList, { props: { runs: [run()], onsettarget } });
    const field = screen.getByRole('spinbutton', {
      name: 'Target quantity for Frame',
    });
    await userEvent.type(field, '30');
    await userEvent.click(
      screen.getByRole('button', { name: 'Set the target quantity for Frame' }),
    );
    expect(onsettarget).toHaveBeenCalledExactlyOnceWith(run(), 30);
    expect(field).toHaveValue(null);
  });

  it('refuses a target that is empty, zero or below what is done, without calling the host', async () => {
    const onsettarget = vi.fn();
    render(ProductionRunList, { props: { runs: [run()], onsettarget } });
    const field = screen.getByRole('spinbutton', {
      name: 'Target quantity for Frame',
    });
    const submit = screen.getByRole('button', {
      name: 'Set the target quantity for Frame',
    });
    await userEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a target greater than zero.',
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(field, '11');
    await userEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The target cannot be below the 12 already done.',
    );
    expect(onsettarget).not.toHaveBeenCalled();
  });

  it('keeps the typed target and says so when the handler fails', async () => {
    const onsettarget = vi.fn(() => false);
    render(ProductionRunList, { props: { runs: [run()], onsettarget } });
    const field = screen.getByRole('spinbutton', {
      name: 'Target quantity for Frame',
    });
    await userEvent.type(field, '30');
    await userEvent.click(
      screen.getByRole('button', { name: 'Set the target quantity for Frame' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The target could not be changed.',
    );
    expect(field).toHaveValue(30);
  });

  it('finishes only after the confirmation, and not when it is dismissed', async () => {
    const onfinish = vi.fn(() => true);
    render(ProductionRunList, { props: { runs: [run()], onfinish } });
    await userEvent.click(screen.getByRole('button', { name: 'Finish Frame' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Finish this run?')).toBeInTheDocument();
    expect(onfinish).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    );
    expect(onfinish).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Finish Frame' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Finish run',
      }),
    );
    expect(onfinish).toHaveBeenCalledExactlyOnceWith(run());
  });

  it('cancels a run only after the confirmation, and reports a failure', async () => {
    const oncancel = vi.fn(() => {
      throw new Error('locked');
    });
    render(ProductionRunList, { props: { runs: [run()], oncancel } });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Frame' }));
    expect(oncancel).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Cancel run',
      }),
    );
    expect(oncancel).toHaveBeenCalledExactlyOnceWith(run());
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The run could not be cancelled.',
      ),
    );
  });

  it('validates a target the way the service does', () => {
    const done = { completedQty: 12 };
    expect(validateTargetQty('12', done)).toEqual({ ok: true, qty: 12 });
    expect(validateTargetQty(' 30.5 ', done)).toEqual({ ok: true, qty: 30.5 });
    expect(validateTargetQty('11.999999', done)).toEqual({
      ok: false,
      reason: 'below_done',
    });
    for (const bad of ['', 'x', '0', '-1', '1000000000']) {
      expect(validateTargetQty(bad, done)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('has no accessibility violations with the controls and a dialog open', async () => {
    const { container } = render(ProductionRunList, {
      props: {
        runs: [run()],
        oncomplete: vi.fn(),
        onsettarget: vi.fn(),
        onfinish: vi.fn(),
        oncancel: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Frame' }));
    await expectNoA11yViolations(document.body);
  });
});
