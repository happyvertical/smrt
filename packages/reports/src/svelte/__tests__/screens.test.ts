// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MaterializedReportTable from '../MaterializedReportTable.svelte';
import { client, proposal, result, saved, spec } from '../preview-data.js';
import ReportConfirmation from '../ReportConfirmation.svelte';
import ReportDetail from '../ReportDetail.svelte';
import ReportPicker from '../ReportPicker.svelte';
import ReportResult from '../ReportResult.svelte';
import RuntimeReportsRoute from '../RuntimeReportsRoute.svelte';
import { validReportProposal, validReportResult } from '../result.js';
import SavedReports from '../SavedReports.svelte';

afterEach(cleanup);

describe('saved report screens', () => {
  it('renders materialized money in each row currency and emits only visible cells', async () => {
    const onDrilldown = vi.fn(async () => {});
    render(MaterializedReportTable, {
      page: {
        descriptor: {
          identityField: 'id',
          dataTable: {
            columns: [
              {
                id: 'currency',
                label: 'Currency',
                accessor: 'currency',
                sortable: true,
                filterable: true,
                align: 'left',
                role: 'data',
                responsive: {},
                valueFormat: 'text',
              },
              {
                id: 'tax_minor',
                label: 'Tax',
                accessor: 'taxMinor',
                sortable: true,
                filterable: false,
                align: 'right',
                role: 'data',
                responsive: {},
                valueFormat: 'money',
              },
            ],
          },
        },
        rows: [{ id: 'cad', currency: 'CAD', taxMinor: 12345 }],
        drilldownColumnIds: ['tax_minor'],
        totalRows: 1,
        offset: 0,
        limit: 25,
      } as never,
      locale: 'en-CA',
      onDrilldown,
    });
    expect(
      screen.getByRole('button', { name: 'Inspect Tax' }).textContent,
    ).toContain('$123.45');
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect Tax' }));
    expect(onDrilldown).toHaveBeenCalledWith({
      id: 'cad',
      columnId: 'tax_minor',
    });
  });
  it('shows the unavailable explanation without a client', () => {
    render(RuntimeReportsRoute, { serverAvailable: false });
    expect(screen.getByText(/host has no server/)).toBeTruthy();
  });
  it('loads tenant-shared reports, filters, and archives through the client', async () => {
    const list = vi.fn(async () => [saved]);
    const archive = vi.fn(async () => {});
    render(SavedReports, { client: client({ list, archive }) });
    expect(await screen.findByRole('link', { name: saved.title })).toBeTruthy();
    expect(list).toHaveBeenCalledWith({
      onlyMine: false,
      includeArchived: false,
    });
    await fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        onlyMine: true,
        includeArchived: false,
      }),
    );
    await fireEvent.click(screen.getByLabelText('Show archived'));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        onlyMine: true,
        includeArchived: true,
      }),
    );
    // Archive is a secondary action: the card's "more" menu, then a confirmation.
    await fireEvent.click(
      await screen.findByRole('button', {
        name: `More actions for ${saved.title}`,
      }),
    );
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(archive).not.toHaveBeenCalled();
    await fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Archive',
      }),
    );
    expect(archive).toHaveBeenCalledWith(saved.id, true);
  });
  it('offers no archive action for a reader and explains assistant-only creation on empty', async () => {
    const mounted = render(SavedReports, {
      client: client({ list: async () => [{ ...saved, canArchive: false }] }),
    });
    await screen.findByRole('link', { name: saved.title });
    expect(
      screen.queryByRole('button', { name: `More actions for ${saved.title}` }),
    ).toBeNull();
    await mounted.rerender({ client: client({ list: async () => [] }) });
    expect(await screen.findByText(/Ask the assistant/)).toBeTruthy();
  });
  it('discards a previous viewer response after the transport changes', async () => {
    let resolve!: (value: (typeof saved)[]) => void;
    const mounted = render(SavedReports, {
      client: client({
        list: () =>
          new Promise((r) => {
            resolve = r;
          }),
      }),
    });
    await waitFor(() => expect(resolve).toBeDefined());
    await mounted.rerender({ client: client({ list: async () => [] }) });
    await screen.findByText(/Ask the assistant/);
    resolve([saved]);
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: saved.title })).toBeNull();
  });
  it('runs as the current viewer on open and re-run, formatting minor units', async () => {
    const run = vi.fn(async () => result);
    render(ReportDetail, {
      id: saved.id,
      client: client({ run }),
      locale: 'en-US',
    });
    expect((await screen.findAllByText('$123.45')).length).toBeGreaterThan(0);
    expect(run).toHaveBeenCalledWith(saved.id);
    await fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getByRole('cell', { name: '$123.45' })).toBeTruthy();
    // Re-run is in the "more" menu: the page runs afresh each time it opens.
    await fireEvent.click(
      screen.getByRole('button', { name: `More actions for ${saved.title}` }),
    );
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Re-run' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
  it.each([
    [{ status: 403 }, /do not have permission/],
    [{ code: 'unknown_field' }, /do not have permission/],
    [{ code: 'invalid_result' }, /invalid result/],
    [new Error('private database detail'), /request failed/],
  ])('shows a safe error state: %s', async (error, message) => {
    render(ReportDetail, {
      id: saved.id,
      client: client({
        run: async () => {
          throw error;
        },
      }),
    });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText('private database detail')).toBeNull();
  });
  it('renders empty data and rejects unsafe integer results', () => {
    render(ReportResult, { result: { ...result, rows: [], rowCount: 0 } });
    expect(screen.getByText('No matching records.')).toBeTruthy();
    expect(
      validReportResult({
        ...result,
        rows: [{ region: 'West', total: 2 ** 53 }],
      }),
    ).toBe(false);
    expect(validReportResult({ ...result, chart: { type: 'radar' } })).toBe(
      false,
    );
    expect(validReportResult({ ...result, chart: { type: 'table' } })).toBe(
      true,
    );
  });
  it('describes the proposal and rejects synthetic approval; decline saves nothing', async () => {
    const confirm = vi.fn(async () => saved);
    render(ReportConfirmation, { proposal, confirm });
    // Measures read as the result's own column labels, not "Sum of amount".
    expect(screen.getByText('Measures').nextElementSibling?.textContent).toBe(
      'Total',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(confirm).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByText('Declined — nothing saved')).toBeTruthy();
  });
  it('shows a saved answer as an outcome line with no buttons', () => {
    render(ReportConfirmation, {
      proposal,
      confirm: async () => saved,
      outcome: { status: 'saved', report: { id: 'report-1', title: 'x' } },
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Open report' }).getAttribute('href'),
    ).toBe('/reports/report-1');
  });
  it('shows an earlier answer read-only, as after a transcript reload', () => {
    render(ReportConfirmation, {
      proposal,
      confirm: async () => saved,
      outcome: { status: 'declined' },
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Declined — nothing saved')).toBeTruthy();
  });
  it('labels groupings, buckets and money filters from the source fields', () => {
    render(ReportConfirmation, {
      proposal: {
        ...proposal,
        spec: {
          ...spec,
          dimensions: [{ field: 'issueDate', bucket: 'month', as: 'region' }],
          filters: [{ field: 'amount', op: 'gt', value: 50000 }],
        },
      },
      confirm: async () => saved,
      fields: [
        { name: 'issueDate', label: 'Issue date' },
        { name: 'amount', label: 'Amount', format: 'money' },
      ],
    });
    expect(screen.getByText('Issue date by month')).toBeTruthy();
    expect(screen.getByText('Amount is greater than $500.00')).toBeTruthy();
  });
  it('refuses a mismatching preview hash', () => {
    render(ReportConfirmation, {
      proposal: { ...proposal, specHash: 'other' },
      confirm: async () => saved,
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('invalid result');
  });
  it('offers saved reports and resets the measure when changing reports', async () => {
    const onchange = vi.fn();
    const mounted = render(ReportPicker, { client: client(), onchange });
    await screen.findByRole('option', { name: saved.title });
    await fireEvent.change(screen.getByLabelText('Report'), {
      target: { value: saved.id },
    });
    expect(onchange).toHaveBeenCalledWith({
      reportId: saved.id,
      measure: '',
      dimension: '',
    });
    await mounted.rerender({ reportId: saved.id });
    // Named as the report names them, not by their aliases.
    expect(screen.getByRole('option', { name: 'Sum of Amount' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Region' })).toBeTruthy();
  });
});

it('refuses malformed proposal projections before showing approval', () => {
  for (const value of [
    null,
    {},
    { ...proposal, spec: {} },
    { ...proposal, spec: { ...proposal.spec, tenantId: 'other' } },
    {
      ...proposal,
      spec: {
        ...proposal.spec,
        chart: { ...proposal.spec.chart, y: ['not_declared'] },
      },
    },
    { ...proposal, sourceLabel: null },
  ]) {
    expect(validReportProposal(value)).toBe(false);
  }
});
