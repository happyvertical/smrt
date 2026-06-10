<script lang="ts">
import {
  EmptyState,
  PageHeader,
  SummaryCard,
} from '@happyvertical/smrt-svelte';

function handleAction() {
  alert('Action button clicked!');
}
</script>

<h1>Layout Components</h1>
<p class="description">Page structure and container components.</p>

<section>
  <h2>PageHeader</h2>
  <p class="section-desc">Standard page header with optional back navigation and action buttons.</p>

  <div class="demo-box">
    <PageHeader title="Projects" subtitle="Manage your active projects" />
  </div>

  <h3>With Back Navigation</h3>
  <div class="demo-box">
    <PageHeader
      title="Project Details"
      subtitle="View and edit project information"
      backHref="/layout"
      backLabel="Projects"
    />
  </div>

  <h3>With Actions</h3>
  <div class="demo-box">
    <PageHeader title="Invoices">
      {#snippet actions()}
        <button class="btn-primary" onclick={handleAction}>New Invoice</button>
        <button class="btn-secondary">Export</button>
      {/snippet}
    </PageHeader>
  </div>
</section>

<section>
  <h2>SummaryCard</h2>
  <p class="section-desc">Statistic/summary display cards for dashboards.</p>

  <div class="demo-grid">
    <SummaryCard label="Total Revenue" value="$24,500" />
    <SummaryCard label="Active Projects" value="12" count={3} />
    <SummaryCard label="Pending Invoices" value="$8,250" href="#" />
  </div>

  <h3>With Variants</h3>
  <div class="demo-grid">
    <SummaryCard label="Healthy Budget" value="$15,000" variant="success" />
    <SummaryCard label="Near Limit" value="$9,500" variant="warning" />
    <SummaryCard label="Over Budget" value="$12,800" variant="danger" />
  </div>

  <h3>Highlighted</h3>
  <div class="demo-grid">
    <SummaryCard label="Selected Item" value="$5,000" highlight />
  </div>
</section>

<section>
  <h2>EmptyState</h2>
  <p class="section-desc">Placeholder for empty lists/content with optional call-to-action.</p>

  <h3>Basic</h3>
  <div class="demo-box">
    <EmptyState
      title="No projects yet"
      description="Get started by creating your first project."
    />
  </div>

  <h3>With Action</h3>
  <div class="demo-box">
    <EmptyState
      title="No invoices found"
      description="Create an invoice to start tracking your revenue."
      actionLabel="Create Invoice"
      onaction={handleAction}
    />
  </div>

  <h3>Different Icons</h3>
  <div class="demo-row" style="gap: 16px;">
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="No documents" icon="document" size="sm" />
    </div>
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="No folders" icon="folder" size="sm" />
    </div>
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="No users" icon="users" size="sm" />
    </div>
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="No results" icon="search" size="sm" />
    </div>
  </div>

  <h3>Sizes</h3>
  <div class="demo-row" style="gap: 16px; align-items: flex-start;">
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="Small" size="sm" />
    </div>
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="Medium" size="md" />
    </div>
    <div class="demo-box" style="flex: 1;">
      <EmptyState title="Large" size="lg" />
    </div>
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>PageHeader</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>title</code></td><td><code>string</code></td><td>required</td><td>Page title</td></tr>
      <tr><td><code>subtitle</code></td><td><code>string</code></td><td>-</td><td>Optional subtitle</td></tr>
      <tr><td><code>backHref</code></td><td><code>string</code></td><td>-</td><td>Back navigation URL</td></tr>
      <tr><td><code>backLabel</code></td><td><code>string</code></td><td><code>'Back'</code></td><td>Back link text</td></tr>
      <tr><td><code>actions</code></td><td><code>Snippet</code></td><td>-</td><td>Action buttons slot</td></tr>
    </tbody>
  </table>

  <h3>SummaryCard</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>label</code></td><td><code>string</code></td><td>required</td><td>Card label</td></tr>
      <tr><td><code>value</code></td><td><code>string | number</code></td><td>required</td><td>Primary value</td></tr>
      <tr><td><code>count</code></td><td><code>number</code></td><td>-</td><td>Optional badge count</td></tr>
      <tr><td><code>href</code></td><td><code>string</code></td><td>-</td><td>Make card clickable</td></tr>
      <tr><td><code>variant</code></td><td><code>'default' | 'success' | 'warning' | 'danger'</code></td><td><code>'default'</code></td><td>Value color</td></tr>
      <tr><td><code>highlight</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Highlight styling</td></tr>
    </tbody>
  </table>

  <h3>EmptyState</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>title</code></td><td><code>string</code></td><td>required</td><td>Main title text</td></tr>
      <tr><td><code>description</code></td><td><code>string</code></td><td>-</td><td>Optional description</td></tr>
      <tr><td><code>icon</code></td><td><code>'document' | 'folder' | 'users' | 'search' | 'inbox'</code></td><td><code>'inbox'</code></td><td>Icon type</td></tr>
      <tr><td><code>actionLabel</code></td><td><code>string</code></td><td>-</td><td>Action button text</td></tr>
      <tr><td><code>actionHref</code></td><td><code>string</code></td><td>-</td><td>Action link URL</td></tr>
      <tr><td><code>onaction</code></td><td><code>() => void</code></td><td>-</td><td>Action click handler</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
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

  .section-desc {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
    margin-bottom: 16px;
  }

  .demo-box {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 16px;
    margin-bottom: 16px;
  }

  .demo-row {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }

  .demo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .btn-primary {
    padding: 8px 16px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary:hover {
    background: var(--smrt-color-primary);
  }

  .btn-secondary {
    padding: 8px 16px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-secondary:hover {
    background: var(--smrt-color-surface-container);
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
