import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { InvoiceEditor, InvoiceReview } from '../index.js';
import type { InvoiceEditorProps } from './types.js';

const props: InvoiceEditorProps = {
  action: '/invoice/save',
  currency: 'CAD',
  allocations: [{ key: 'row-a', sourceId: 'source-1', amount: '125.00' }],
  sources: [
    { id: 'source-1', label: 'Reviewed expense', availableMinor: 25000 },
  ],
  hiddenFields: [
    { name: 'requestId', value: 'caller-token' },
    { name: 'tenant', value: 'tenant-a' },
  ],
};
const html = (overrides: Partial<InvoiceEditorProps> = {}) =>
  render(InvoiceEditor, { props: { ...props, ...overrides } }).body;

describe('Invoice preparation native SSR contract', () => {
  it('publishes components and registry slots', () => {
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-editor'),
    ).toBe(InvoiceEditor);
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-review'),
    ).toBe(InvoiceReview);
  });
  it('renders native action, caller tokens, lossless amounts and submitter intent', () => {
    const body = html();
    expect(body).toContain('action="/invoice/save"');
    expect(body).toContain('method="post"');
    expect(body).toMatch(
      /<input[^>]*value="caller-token"[^>]*name="requestId"/,
    );
    expect(body).toContain('name="allocationAmount"');
    expect(body).toContain('value="125.00"');
    expect(body).toContain('value="addAllocation"');
    expect(body).toContain('formnovalidate');
  });
  it('retains invalid values, selected removals, unknown source, custom names and repeated hidden fields', () => {
    const body = html({
      allocations: [
        {
          key: 'row',
          sourceId: 'gone',
          amount: 'oops.12',
          remove: true,
          amountError: 'Invalid amount',
        },
      ],
      fields: { source: 'costId', amount: 'amountText', intent: 'operation' },
      hiddenFields: [
        { name: 'context', value: 'a' },
        { name: 'context', value: 'b' },
      ],
      message: 'Denied; retained',
      retryStatus: 'transport-error',
    });
    expect(body).toContain('value="gone" selected');
    expect(body).toContain('value="oops.12"');
    expect(body).toContain('name="costId"');
    expect(body).toContain('name="amountText"');
    expect(body).toContain('name="operation"');
    expect(body).toContain('name="removeRow" value="0"');
    expect(body).toContain('checked');
    expect(body).toContain('Invalid amount');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('Denied; retained');
    expect(body).toContain('The outcome is uncertain');
    expect(body.match(/name="context"/g)).toHaveLength(2);
  });
  it('does not expose supplied source details to restricted readers', () => {
    const body = html({ mayReadSources: false });
    expect(body).not.toContain('Reviewed expense');
    expect(body).not.toContain('25000');
    expect(body).not.toContain('<select');
    expect(body).toContain('Source reference');
    expect(body).toContain('value="source-1"');
  });
  it('read-only and pending states do not offer enabled mutation actions', () => {
    const body = html({ canEdit: false });
    expect(body).toContain('<fieldset disabled');
    expect(body).not.toContain('value="save"');
    expect(body).not.toContain('value="addAllocation"');
    const pending = html({ retryStatus: 'submitting' });
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toMatch(/<button[^>]*disabled[^>]*name="intent"/);
  });
  it('preserves selected unavailable sources and presents caller review without enum assumptions', () => {
    const body = html({
      sources: [
        {
          id: 'source-1',
          label: 'Changed source',
          availableMinor: 0,
          selectable: false,
        },
      ],
      review: {
        label: 'Future review state',
        message: 'Approval invalidated by server',
      },
    });
    expect(body).toContain('Future review state');
    expect(body).toContain('Approval invalidated by server');
    expect(body).toContain('value="source-1" selected');
    expect(body).not.toMatch(/<option[^>]*disabled[^>]*value="source-1"/);
    expect(html({ allocations: [], sources: [] })).toContain('No allocations');
  });
});
