import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
  InvoiceAllocationFields,
  InvoiceEditor,
  InvoiceReview,
} from '../index.js';
import type { InvoiceAllocationFieldsProps } from './types.js';

const props: InvoiceAllocationFieldsProps = {
  currency: 'CAD',
  allocations: [{ key: 'row-a', sourceId: 'source-1', amount: '125.00' }],
  sources: [
    { id: 'source-1', label: 'Reviewed expense', availableMinor: 25000 },
  ],
};
const html = (overrides: Partial<InvoiceAllocationFieldsProps> = {}) =>
  render(InvoiceAllocationFields, { props: { ...props, ...overrides } }).body;

describe('Invoice preparation native SSR contract', () => {
  it('publishes components and registry slots', () => {
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-editor'),
    ).toBe(InvoiceEditor);
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-review'),
    ).toBe(InvoiceReview);
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
    const pending = html({ pending: true });
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
    });

    expect(body).toContain('value="source-1" selected');
    expect(body).not.toMatch(/<option[^>]*disabled[^>]*value="source-1"/);
    expect(html({ allocations: [], sources: [] })).toContain('No allocations');
  });
});
