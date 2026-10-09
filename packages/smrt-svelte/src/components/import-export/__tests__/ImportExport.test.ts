import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ImportExport from '../ImportExport.svelte';
import type { ExportFile, ImportExportField } from '../types.js';

const fields: ImportExportField[] = [
  {
    name: 'id',
    label: 'ID',
    type: 'reference',
    required: false,
    importable: false,
    exportable: true,
  },
  {
    name: 'name',
    label: 'Name',
    type: 'text',
    required: true,
    importable: true,
    exportable: true,
  },
  {
    name: 'qty',
    label: 'Quantity',
    type: 'integer',
    required: false,
    importable: true,
    exportable: true,
  },
];

beforeAll(() => {
  // jsdom's Blob lacks text(); real browsers have it.
  if (typeof Blob.prototype.text !== 'function') {
    Blob.prototype.text = function text(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
});

function csvFile(content: string, name = 'items.csv') {
  return new File([content], name, { type: 'text/csv' });
}

async function pick(content: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  await userEvent.upload(input, csvFile(content));
}

describe('ImportExport import', () => {
  it('maps columns, previews validation, and imports only valid rows', async () => {
    const createRecord = vi.fn(async () => ({}));
    const onimported = vi.fn();
    render(ImportExport, { props: { fields, createRecord, onimported } });

    await pick('Name,Qty\nWidget,3\n,4\nGadget,x\nThing,5\n');

    expect(
      await screen.findByRole('heading', { name: 'Map columns' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Field for column Name')).toHaveValue('name');
    expect(screen.getByLabelText('Field for column Qty')).toHaveValue('qty');
    expect(
      await screen.findByText(/2 of 4 rows are ready; 2 have problems\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Expected a whole number.')).toBeInTheDocument();
    expect(createRecord).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole('button', { name: 'Import 2 rows' }),
    );
    await waitFor(() => expect(onimported).toHaveBeenCalled());
    expect(createRecord.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        { name: 'Widget', qty: 3 },
        { name: 'Thing', qty: 5 },
      ]),
    );
    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText('Imported 2 of 2 rows.'),
    ).toBeInTheDocument();
  });

  it('blocks import until required fields are mapped, then recovers', async () => {
    const createRecord = vi.fn(async () => ({}));
    render(ImportExport, { props: { fields, createRecord } });
    await pick('Item,Qty\nWidget,3\n');

    const importButton = () =>
      screen.getByRole('button', { name: /^Import \d+ rows$/ });
    expect(
      await screen.findByText('Fix the column mapping above to continue.'),
    ).toBeInTheDocument();
    expect(importButton()).toBeDisabled();

    await userEvent.selectOptions(
      screen.getByLabelText('Field for column Item'),
      'name',
    );
    await waitFor(() => expect(importButton()).toBeEnabled());
    expect(
      screen.queryByText('Fix the column mapping above to continue.'),
    ).not.toBeInTheDocument();
  });

  it('reports server rejections and offers the error report', async () => {
    const files: ExportFile[] = [];
    const createRecord = vi.fn(async (v: Record<string, unknown>) => {
      if (v.name === 'Bad') throw new Error('duplicate key');
    });
    render(ImportExport, {
      props: {
        fields,
        createRecord,
        ondownload: (f: ExportFile) => files.push(f),
      },
    });
    await pick('Name,Qty\nGood,1\nBad,2\n');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Import 2 rows' }),
    );

    expect(
      await screen.findByText('1 rows were rejected by the server.'),
    ).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', {
      name: 'Download error report',
    });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('duplicate key');
  });

  it('shows a clear error for an unterminated quote and an oversized file', async () => {
    render(ImportExport, {
      props: { fields, createRecord: async () => ({}), maxFileBytes: 40 },
    });
    await pick('Name\n"oops\n');
    expect(await screen.findByText(/never closed/)).toBeInTheDocument();
    await pick(`Name\n${'x'.repeat(100)}\n`);
    expect(await screen.findByText(/the limit is/)).toBeInTheDocument();
  });

  it('has no axe violations with a file loaded', async () => {
    const { container } = render(ImportExport, {
      props: { fields, createRecord: async () => ({}) },
    });
    await pick('Name,Qty\nWidget,3\n');
    await screen.findByRole('heading', { name: 'Map columns' });
    await expectNoA11yViolations(container);
  });
});

describe('ImportExport export', () => {
  const rows = [
    { id: '1', name: 'Widget', qty: 3 },
    { id: '2', name: '=cmd', qty: -1 },
  ];

  it('exports the selected columns and reports the result', async () => {
    const files: ExportFile[] = [];
    const loadRows = vi.fn(async () => rows);
    render(ImportExport, {
      props: {
        fields,
        loadRows,
        ondownload: (f: ExportFile) => files.push(f),
        filename: 'items',
      },
    });

    await userEvent.click(screen.getByRole('checkbox', { name: 'ID' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Export 2 columns' }),
    );

    expect(
      await screen.findByText('Exported 2 rows and 2 columns to items.csv.'),
    ).toBeInTheDocument();
    expect(files).toHaveLength(1);
    const text = files[0].content.replace('﻿', '');
    expect(text.split('\r\n')[0]).toBe('name,qty');
    expect(text).toContain("'=cmd");
    expect(text).not.toContain('"1"');
  });

  it('refuses to export with no columns', async () => {
    render(ImportExport, { props: { fields, loadRows: async () => rows } });
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(
      screen.getByRole('button', { name: 'Export 0 columns' }),
    ).toBeDisabled();
    expect(screen.getByText('Select at least one column.')).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    render(ImportExport, {
      props: {
        fields,
        loadRows: async () => {
          throw new Error('offline');
        },
        ondownload: () => {},
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Export 3 columns' }),
    );
    expect(
      await screen.findByText('The export failed: offline'),
    ).toBeInTheDocument();
  });

  it('switches between import and export when both are available', async () => {
    render(ImportExport, {
      props: {
        fields,
        createRecord: async () => ({}),
        loadRows: async () => rows,
      },
    });
    expect(screen.getByText('Spreadsheet file')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Export' }));
    expect(
      await screen.findByRole('heading', { name: 'Choose columns' }),
    ).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Columns to export' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(3);
  });

  it('has no axe violations', async () => {
    const { container } = render(ImportExport, {
      props: { fields, loadRows: async () => rows },
    });
    await expectNoA11yViolations(container);
  });
});
