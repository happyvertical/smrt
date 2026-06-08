<script lang="ts">
import type {
  InvoiceData,
  InvoiceStatus,
  LineItem,
  UnbilledItem,
} from '@happyvertical/smrt-commerce/svelte';
import {
  InvoiceActions,
  InvoiceCard,
  InvoiceHeader,
  InvoiceLineItems,
  InvoiceTotals,
  UnbilledItems,
} from '@happyvertical/smrt-commerce/svelte';

// Sample invoice data
const invoices: InvoiceData[] = [
  {
    id: '1',
    invoiceNumber: 'INV-2024-001',
    status: 'paid',
    issueDate: new Date('2024-01-15'),
    dueDate: new Date('2024-02-15'),
    totalAmount: 250000,
    customerName: 'Acme Corp',
    projectName: 'Website Redesign',
  },
  {
    id: '2',
    invoiceNumber: 'INV-2024-002',
    status: 'sent',
    issueDate: new Date('2024-02-01'),
    dueDate: new Date('2024-03-01'),
    totalAmount: 175000,
    customerName: 'TechStart Inc',
  },
  {
    id: '3',
    invoiceNumber: 'INV-2024-003',
    status: 'overdue',
    issueDate: new Date('2024-01-01'),
    dueDate: new Date('2024-01-31'),
    totalAmount: 85000,
    customerName: 'Local Business LLC',
  },
  {
    id: '4',
    invoiceNumber: 'INV-2024-004',
    status: 'draft',
    issueDate: new Date(),
    totalAmount: 45000,
    customerName: 'New Client',
  },
];

// Sample line items
const lineItems: LineItem[] = [
  {
    id: '1',
    description: 'Website Development - Initial Build',
    quantity: 40,
    unitPrice: 12500,
    amount: 500000,
    sourceType: 'time',
  },
  {
    id: '2',
    description: 'Design Mockups and Wireframes',
    quantity: 1,
    unitPrice: 150000,
    amount: 150000,
    sourceType: 'manual',
  },
  {
    id: '3',
    description: 'Hosting Setup (Annual)',
    quantity: 1,
    unitPrice: 50000,
    amount: 50000,
    sourceType: 'expense',
    category: 'Infrastructure',
  },
];

// Sample unbilled items
let unbilledItems: UnbilledItem[] = $state([
  {
    id: '1',
    type: 'time',
    description: 'Bug fixes - Authentication module',
    date: new Date('2024-02-20'),
    amount: 37500,
    category: 'Development',
  },
  {
    id: '2',
    type: 'expense',
    description: 'Adobe Creative Cloud License',
    date: new Date('2024-02-18'),
    amount: 8500,
    category: 'Software',
  },
  {
    id: '3',
    type: 'time',
    description: 'Client meeting and requirements gathering',
    date: new Date('2024-02-22'),
    amount: 25000,
    category: 'Consulting',
  },
  {
    id: '4',
    type: 'expense',
    description: 'Stock photos purchase',
    date: new Date('2024-02-21'),
    amount: 4500,
    category: 'Assets',
  },
]);

// Invoice demo state
let demoStatus: InvoiceStatus = $state('draft');

function handleStatusChange(status: InvoiceStatus) {
  demoStatus = status;
}

function handleAction(action: string) {
  alert(`Action: ${action}`);
}

function handleCreateInvoice(ids: string[]) {
  alert(`Creating invoice with ${ids.length} items`);
}
</script>

<h1>Commerce Components</h1>
<p class="description">Invoice and billing components for commerce applications.</p>

<section>
  <h2>InvoiceCard</h2>
  <p class="section-desc">Compact card view for invoice lists.</p>

  <div class="invoice-grid">
    {#each invoices as invoice}
      <InvoiceCard {invoice} onclick={() => alert(`Clicked ${invoice.invoiceNumber}`)} />
    {/each}
  </div>
</section>

<section>
  <h2>Full Invoice Display</h2>
  <p class="section-desc">Complete invoice layout combining Header, LineItems, Totals, and Actions.</p>

  <div class="invoice-demo">
    <InvoiceHeader
      invoiceNumber="INV-2024-005"
      status={demoStatus}
      issueDate={new Date()}
      dueDate={new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)}
      customerName="Premium Client Inc"
      projectName="Mobile App Development"
    />

    <InvoiceLineItems
      items={lineItems}
      showSource
    />

    <InvoiceTotals
      subtotal={700000}
      taxRate={5}
      total={735000}
      showTax
    />

    <InvoiceActions
      status={demoStatus}
      onsend={() => handleAction('send')}
      onmarkpaid={() => handleAction('mark paid')}
      onedit={() => handleAction('edit')}
      ondelete={() => handleAction('delete')}
      onprint={() => handleAction('print')}
      onexport={() => handleAction('export')}
    />

    <div class="status-controls">
      <label for="status-select">Change Status:</label>
      <select id="status-select" bind:value={demoStatus}>
        <option value="draft">Draft</option>
        <option value="sent">Sent</option>
        <option value="viewed">Viewed</option>
        <option value="paid">Paid</option>
        <option value="overdue">Overdue</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>
  </div>
</section>

<section>
  <h2>InvoiceTotals Variations</h2>
  <p class="section-desc">Different configurations for the totals section.</p>

  <div class="demo-row">
    <div class="demo-box" style="flex: 1;">
      <h4>Basic</h4>
      <InvoiceTotals subtotal={500000} total={500000} showTax={false} />
    </div>
    <div class="demo-box" style="flex: 1;">
      <h4>With Tax</h4>
      <InvoiceTotals subtotal={500000} taxRate={5} total={525000} />
    </div>
    <div class="demo-box" style="flex: 1;">
      <h4>With Payment</h4>
      <InvoiceTotals subtotal={500000} taxRate={5} total={525000} amountPaid={200000} showPaid />
    </div>
  </div>
</section>

<section>
  <h2>UnbilledItems</h2>
  <p class="section-desc">Select unbilled time and expenses to create invoices.</p>

  <div class="demo-box">
    <UnbilledItems
      bind:items={unbilledItems}
      oncreate={handleCreateInvoice}
    />
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>InvoiceCard</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>invoice</code></td><td><code>InvoiceData</code></td><td>Invoice data object</td></tr>
      <tr><td><code>currency</code></td><td><code>'CAD' | 'USD'</code></td><td>Currency code</td></tr>
      <tr><td><code>href</code></td><td><code>string</code></td><td>Navigation link</td></tr>
      <tr><td><code>onclick</code></td><td><code>() => void</code></td><td>Click handler</td></tr>
    </tbody>
  </table>

  <h3>InvoiceHeader</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>invoiceNumber</code></td><td><code>string</code></td><td>Invoice reference</td></tr>
      <tr><td><code>status</code></td><td><code>InvoiceStatus</code></td><td>Current status</td></tr>
      <tr><td><code>issueDate</code></td><td><code>Date | string</code></td><td>Issue date</td></tr>
      <tr><td><code>dueDate</code></td><td><code>Date | string | null</code></td><td>Due date</td></tr>
      <tr><td><code>customerName</code></td><td><code>string</code></td><td>Customer name</td></tr>
      <tr><td><code>projectName</code></td><td><code>string</code></td><td>Project name</td></tr>
    </tbody>
  </table>

  <h3>InvoiceLineItems</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>items</code></td><td><code>LineItem[]</code></td><td>Line items array</td></tr>
      <tr><td><code>editable</code></td><td><code>boolean</code></td><td>Enable editing</td></tr>
      <tr><td><code>showSource</code></td><td><code>boolean</code></td><td>Show source type column</td></tr>
      <tr><td><code>currency</code></td><td><code>'CAD' | 'USD'</code></td><td>Currency code</td></tr>
    </tbody>
  </table>

  <h3>InvoiceTotals</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>subtotal</code></td><td><code>number</code></td><td>Subtotal in cents</td></tr>
      <tr><td><code>taxRate</code></td><td><code>number</code></td><td>Tax rate percentage</td></tr>
      <tr><td><code>total</code></td><td><code>number</code></td><td>Total in cents</td></tr>
      <tr><td><code>amountPaid</code></td><td><code>number</code></td><td>Amount paid in cents</td></tr>
      <tr><td><code>showTax</code></td><td><code>boolean</code></td><td>Show tax breakdown</td></tr>
      <tr><td><code>showPaid</code></td><td><code>boolean</code></td><td>Show payment status</td></tr>
    </tbody>
  </table>

  <h3>InvoiceActions</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>status</code></td><td><code>InvoiceStatus</code></td><td>Current status</td></tr>
      <tr><td><code>onsend</code></td><td><code>() => void</code></td><td>Send handler</td></tr>
      <tr><td><code>onmarkpaid</code></td><td><code>() => void</code></td><td>Mark paid handler</td></tr>
      <tr><td><code>onedit</code></td><td><code>() => void</code></td><td>Edit handler</td></tr>
      <tr><td><code>ondelete</code></td><td><code>() => void</code></td><td>Delete handler</td></tr>
    </tbody>
  </table>

  <h3>UnbilledItems</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>items</code></td><td><code>UnbilledItem[]</code></td><td>Unbilled items</td></tr>
      <tr><td><code>currency</code></td><td><code>'CAD' | 'USD'</code></td><td>Currency code</td></tr>
      <tr><td><code>oncreate</code></td><td><code>(ids: string[]) => void</code></td><td>Create invoice handler</td></tr>
      <tr><td><code>onselectionchange</code></td><td><code>(ids: string[]) => void</code></td><td>Selection change handler</td></tr>
    </tbody>
  </table>
</section>

<style>
  h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .description {
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 32px;
  }

  section {
    margin-bottom: 48px;
  }

  h2 {
    font-size: 1.25rem;
    color: var(--smrt-color-on-surface);
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  h3 {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
    margin: 24px 0 12px;
    font-weight: 500;
  }

  h4 {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin: 0 0 12px;
    font-weight: 500;
    text-transform: uppercase;
  }

  .section-desc {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
    margin-bottom: 16px;
  }

  .invoice-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 16px;
  }

  .invoice-demo {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .status-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid var(--smrt-color-outline-variant);
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .status-controls select {
    padding: 6px 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.875rem;
  }

  .demo-box {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 16px;
  }

  .demo-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  .props-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
    margin-top: 8px;
    margin-bottom: 24px;
  }

  .props-table th,
  .props-table td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .props-table th {
    background: var(--smrt-color-surface-container);
    font-weight: 500;
  }

  code {
    background: var(--smrt-color-surface-container);
    padding: 2px 6px;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.8rem;
  }
</style>
