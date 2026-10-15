import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PurchaseOrderEditor from '../src/svelte/components/PurchaseOrderEditor.svelte';

describe('purchase money header', () => {
  it('renders inclusive tax and validates it with retained allocation rows', () => {
    const body = render(PurchaseOrderEditor, {
      props: {
        source: { id: 'quote', label: 'Quote Q-1', vendor: 'Vendor' }, currency: 'CAD',
        minorUnitDigits: 2, instruments: [{ value: 'po', label: 'Purchase order' }], action: '/purchase',
        values: {
          instrument: 'po', tax: '4.00', scope: 'Scope', inclusions: '', exclusions: '', reason: 'Award',
          allocations: [{ id: 'line', label: 'Work', amount: '105.00' }],
        },
        money: { lineAmountType: 'inclusive', taxMinor: 500, totalMinor: 10500, minorUnitDigits: 2 },
      },
    }).body;
    expect(body).toContain('Amounts are tax inclusive');
    expect(body).toContain('Includes tax of 5.00 CAD');
    expect(body).toContain('Tax must match calculated line tax.');
    expect(body).toContain('name="lineAmountType"');
  });
});
