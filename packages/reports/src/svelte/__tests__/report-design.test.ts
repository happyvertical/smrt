// @vitest-environment jsdom
/**
 * #4100 design pass: how report screens describe a report (period dates,
 * measure labels, headline figures), the saved-report cards and their "New
 * report" ask, the report page's actions, and the measure switch.
 */
import {
  ASSISTANT_REQUEST_EVENT,
  type AssistantRequestDetail,
} from '@happyvertical/smrt-ui/chat';
import { getRegisteredDefault } from '@happyvertical/smrt-ui/i18n';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeReport,
  relativeTime,
  reportCsv,
  reportFigures,
} from '../describe.js';
import { M } from '../messages.js';
import { client, result, saved, spec } from '../preview-data.js';
import ReportDetail from '../ReportDetail.svelte';
import ReportResult from '../ReportResult.svelte';
import SavedReports from '../SavedReports.svelte';
import type { RuntimeReportResult, RuntimeReportSpec } from '../types.js';

afterEach(cleanup);

void M; // registers the defaults
const t = (key: string, values: Record<string, unknown> = {}) =>
  String(getRegisteredDefault(key) ?? key).replace(
    /\{(\w+)\}/g,
    (_, name: string) => String(values[name] ?? ''),
  );

const monthly: RuntimeReportSpec = {
  ...spec,
  title: 'Invoices by month',
  source: 'invoices',
  dimensions: [{ field: 'issueDate', as: 'issue_date_month', bucket: 'month' }],
  measures: [
    { fn: 'sum', field: 'totalAmount', as: 'total_amount' },
    { fn: 'count', as: 'number_of_invoices' },
  ],
  filters: [
    { field: 'issueDate', op: 'gte', value: '2025-12-01' },
    { field: 'issueDate', op: 'lt', value: '2026-01-01' },
    { field: 'status', op: 'eq', value: 'paid' },
  ],
  chart: { type: 'line', x: 'issue_date_month', y: ['total_amount'] },
};
const monthlyResult: RuntimeReportResult = {
  ...result,
  title: monthly.title,
  columns: [
    {
      id: 'issue_date_month',
      label: 'Issue date month',
      role: 'dimension',
      type: 'datetime',
      bucket: 'month',
    },
    {
      id: 'total_amount',
      label: 'Total amount',
      role: 'measure',
      type: 'integer',
      format: 'money',
    },
    {
      id: 'number_of_invoices',
      label: 'Number of invoices',
      role: 'measure',
      type: 'integer',
    },
  ] as RuntimeReportResult['columns'],
  rows: [
    {
      issue_date_month: '2025-10-01T00:00:00.000Z',
      total_amount: 100_00,
      number_of_invoices: 2,
    },
    {
      issue_date_month: '2025-11-01T00:00:00.000Z',
      total_amount: 400_00,
      number_of_invoices: 5,
    },
    {
      issue_date_month: '2025-12-01T00:00:00.000Z',
      total_amount: 250_00,
      number_of_invoices: 3,
    },
  ],
  rowCount: 3,
  chart: monthly.chart,
};

describe('describeReport', () => {
  it('names the source, groupings, period dates, measures and other filters', () => {
    const described = describeReport(monthly, {
      t,
      locale: 'en-US',
      currency: 'USD',
      source: {
        id: 'invoices',
        label: 'Invoices',
        fields: [
          { name: 'issueDate', label: 'Issue date', type: 'datetime' },
          { name: 'status', label: 'Status' },
        ],
      },
      columns: monthlyResult.columns,
    });
    expect(described.source).toBe('Invoices');
    expect(described.groupings).toBe('Issue date by month');
    // The exclusive upper bound reads as the last day covered.
    // Intl puts thin spaces around the dash; compare the words.
    const plain = (text = '') => text.replace(/\s/g, ' ');
    expect(plain(described.period?.range)).toBe('Dec 1 – 31, 2025');
    expect(described.period?.field).toBe('Issue date');
    expect(described.measures).toEqual(['Total amount', 'Number of invoices']);
    expect(described.filters).toEqual(['Status equals paid']);
    expect(plain(described.line)).toBe(
      'Invoices · Issue date by month · Dec 1 – 31, 2025',
    );
  });

  it('humanizes an unknown source and labels measures from the spec alone', () => {
    const described = describeReport(spec, {
      t,
      locale: 'en',
      currency: 'USD',
    });
    expect(described.source).toBe('Sales');
    expect(described.measures).toEqual(['Sum of Amount']);
    expect(described.period).toBeNull();
  });
});

describe('reportFigures', () => {
  const groupLabel = (row: RuntimeReportResult['rows'][number]) =>
    String(row.issue_date_month).slice(0, 7);
  const measure = monthlyResult
    .columns[1] as RuntimeReportResult['columns'][number];

  it('totals an additive measure, averages per bucket and finds the peak', () => {
    const figures = reportFigures(monthlyResult, measure, {
      t,
      locale: 'en-US',
      currency: 'USD',
      groupLabel,
      fn: 'sum',
    });
    expect(figures).toEqual([
      { label: 'Total', value: '$750.00' },
      { label: 'Average per month', value: '$250.00' },
      { label: 'Peak', value: '$400.00', detail: '2025-11' },
    ]);
  });

  it('never totals a measure that does not add up', () => {
    const figures = reportFigures(monthlyResult, measure, {
      t,
      locale: 'en-US',
      currency: 'USD',
      groupLabel,
      fn: 'avg',
    });
    expect(figures.map((f) => f.label)).toEqual(['Average per month', 'Peak']);
  });
});

describe('CSV and times', () => {
  it('quotes cells and keeps a value from being read as a formula', () => {
    const csv = reportCsv(
      {
        ...result,
        rows: [{ region: '=HYPERLINK("x")', total: 12345 }],
      },
      (value, column) =>
        column.id === 'total' ? '$123.45' : String(value ?? ''),
    );
    expect(csv).toBe('Region,Total\r\n"\'=HYPERLINK(""x"")",$123.45\r\n');
  });

  it('leaves negative numbers as numbers (R14-F1)', () => {
    const csv = reportCsv(
      {
        ...result,
        rows: [
          { region: '-West', total: -500 },
          { region: 'East', total: -3 },
        ],
      },
      (value, column) =>
        column.id === 'total'
          ? value === -500
            ? '-$5.00'
            : String(value)
          : String(value ?? ''),
    );
    expect(csv).toBe("Region,Total\r\n'-West,-$5.00\r\nEast,-3\r\n");
  });

  it('reads a time relative to now', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(relativeTime('2026-10-15T12:00:00Z', 'en', now)).toBe('2 days ago');
    expect(relativeTime('2026-10-17T11:59:30Z', 'en', now)).toBe('now');
  });
});

describe('saved report cards', () => {
  it('shows each report as a card with its figure, and asks the assistant for a new one', async () => {
    const monthlySaved = {
      ...saved,
      id: 'r-month',
      title: monthly.title,
      sourceId: 'invoices',
      spec: monthly,
      savedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    };
    const asked: string[] = [];
    const take = (event: Event) => {
      asked.push((event as CustomEvent<AssistantRequestDetail>).detail.prompt);
      event.preventDefault();
    };
    document.addEventListener(ASSISTANT_REQUEST_EVENT, take);
    try {
      render(SavedReports, {
        client: client({
          list: async () => [monthlySaved],
          run: async () => monthlyResult,
        }),
        locale: 'en-US',
        authorLabel: (id: string) => (id === 'alice' ? 'You' : undefined),
        sources: [{ id: 'invoices', label: 'Invoices' }],
      });
      const card = (
        await screen.findByRole('link', { name: monthly.title })
      ).closest('[data-smrt-component="SavedReportCard"]') as HTMLElement;
      expect(
        within(card).getByText(/Invoices · Issue date by month/),
      ).toBeTruthy();
      // The headline is the period's total of the charted measure.
      expect(await within(card).findByText('$750.00')).toBeTruthy();
      expect(within(card).getByText('Saved by You 2 days ago')).toBeTruthy();
      await fireEvent.click(screen.getByRole('button', { name: 'New report' }));
      expect(asked).toEqual(['Make a report of ']);
      expect(screen.queryByText(/Open the assistant and ask/)).toBeNull();
    } finally {
      document.removeEventListener(ASSISTANT_REQUEST_EVENT, take);
    }
  });

  it('says where to ask when no assistant is on the page', async () => {
    render(SavedReports, { client: client({ list: async () => [] }) });
    expect(await screen.findByText('No saved reports yet')).toBeTruthy();
    // The empty state's own action, beside the page's.
    const buttons = screen.getAllByRole('button', { name: 'New report' });
    expect(buttons).toHaveLength(2);
    await fireEvent.click(buttons[1] as HTMLElement);
    expect(
      screen.getByText(/Open the assistant and ask for a report/),
    ).toBeTruthy();
  });

  it('the section variant offers View all only when more reports exist', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...saved,
      id: `r-${i}`,
      title: `Report ${i}`,
    }));
    render(SavedReports, {
      client: client({ list: async () => many }),
      variant: 'section',
      limit: 2,
      listHref: '/reports',
    });
    await screen.findByRole('link', { name: 'Report 0' });
    expect(screen.queryByRole('link', { name: 'Report 2' })).toBeNull();
    expect(
      screen
        .getByRole('link', { name: 'View all saved reports' })
        .getAttribute('href'),
    ).toBe('/reports');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});

describe('a report page', () => {
  it('summarizes the report and edits it through the assistant', async () => {
    const asked: string[] = [];
    const take = (event: Event) => {
      asked.push((event as CustomEvent<AssistantRequestDetail>).detail.prompt);
      event.preventDefault();
    };
    document.addEventListener(ASSISTANT_REQUEST_EVENT, take);
    try {
      render(ReportDetail, {
        id: 'r-month',
        client: client({
          get: async () => ({ ...saved, title: monthly.title, spec: monthly }),
          run: async () => monthlyResult,
        }),
        locale: 'en-US',
      });
      const facts = await screen
        .findByRole('group', { name: 'Report details' })
        .catch(() => screen.getByLabelText('Report details'));
      expect(within(facts).getByText('Issue date by month')).toBeTruthy();
      expect(within(facts).getByText(/Dec 1 – 31, 2025/)).toBeTruthy();
      await screen.findByText('$750.00');
      await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(asked).toEqual(['Change the report “Invoices by month”: ']);
    } finally {
      document.removeEventListener(ASSISTANT_REQUEST_EVENT, take);
    }
  });

  it('exports the formatted result as CSV', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:report';
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    try {
      render(ReportDetail, { id: saved.id, client: client(), locale: 'en-US' });
      await screen.findAllByText('$123.45');
      await fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      expect(click).toHaveBeenCalledOnce();
      expect(await created[0]?.text()).toBe('Region,Total\r\nWest,$123.45\r\n');
    } finally {
      click.mockRestore();
    }
  });

  it('offers Restore, not Edit, on an archived report and does not run it', async () => {
    const run = vi.fn(async () => result);
    const archive = vi.fn(async () => {});
    render(ReportDetail, {
      id: saved.id,
      client: client({
        get: async () => ({ ...saved, status: 'archived' as const }),
        run,
        archive,
      }),
    });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Restore' }),
    );
    expect(archive).toHaveBeenCalledWith(saved.id, false);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('measure switch', () => {
  it('charts one measure at a time and switches between them', async () => {
    render(ReportResult, {
      result: monthlyResult,
      spec: monthly,
      variant: 'full',
      locale: 'en-US',
    });
    expect(screen.getByText('Total amount by month')).toBeTruthy();
    await fireEvent.click(
      screen.getByRole('radio', { name: 'Number of invoices' }),
    );
    await waitFor(() =>
      expect(screen.getByText('Number of invoices by month')).toBeTruthy(),
    );
    // A count adds up too: its total is a figure.
    expect(screen.getByText('10')).toBeTruthy();
  });
});
