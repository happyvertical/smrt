<script lang="ts">
import { DataTable } from '@happyvertical/smrt-svelte';
import type { DataTableColumn } from '@happyvertical/smrt-svelte/components/data/types';

// Sample data
interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  status: 'active' | 'inactive' | 'pending';
  created: string;
}

const users: User[] = [
  {
    id: 1,
    name: 'Alice Johnson',
    email: 'alice@example.com',
    role: 'Admin',
    status: 'active',
    created: '2024-01-15',
  },
  {
    id: 2,
    name: 'Bob Smith',
    email: 'bob@example.com',
    role: 'Editor',
    status: 'active',
    created: '2024-02-20',
  },
  {
    id: 3,
    name: 'Carol White',
    email: 'carol@example.com',
    role: 'Viewer',
    status: 'inactive',
    created: '2024-03-10',
  },
  {
    id: 4,
    name: 'David Brown',
    email: 'david@example.com',
    role: 'Editor',
    status: 'pending',
    created: '2024-04-05',
  },
  {
    id: 5,
    name: 'Eve Davis',
    email: 'eve@example.com',
    role: 'Admin',
    status: 'active',
    created: '2024-05-18',
  },
];

const columns: DataTableColumn<User>[] = [
  { id: 'name', label: 'Name', sortable: true },
  { id: 'email', label: 'Email', sortable: true },
  { id: 'role', label: 'Role', sortable: true },
  { id: 'status', label: 'Status', sortable: true },
  { id: 'created', label: 'Created', sortable: true },
];

// State
let selected = $state(new Set<number>());
let sort = $state({
  columnId: null as string | null,
  direction: null as 'asc' | 'desc' | null,
});
let loading = $state(false);

function toggleLoading() {
  loading = true;
  setTimeout(() => {
    loading = false;
  }, 2000);
}

function handleRowClick(row: User) {
  alert(`Clicked: ${row.name}`);
}
</script>

<h1>Data Components</h1>
<p class="description">Components for displaying and interacting with data.</p>

<section>
  <h2>DataTable</h2>
  <p class="section-desc">A flexible, accessible data table with sorting, selection, and custom rendering.</p>

  <h3>Basic Table</h3>
  <div class="demo-box">
    <DataTable
      data={users}
      {columns}
      rowKey="id"
    />
  </div>

  <h3>Sortable Table</h3>
  <div class="demo-box">
    <DataTable
      data={users}
      {columns}
      rowKey="id"
      sortable
      bind:sort
    />
    <p class="state-display">Sort: {sort.columnId || 'none'} {sort.direction || ''}</p>
  </div>

  <h3>Selectable Table</h3>
  <div class="demo-box">
    <DataTable
      data={users}
      {columns}
      rowKey="id"
      selectable
      bind:selected
    />
    <p class="state-display">Selected: {[...selected].join(', ') || 'none'}</p>
  </div>

  <h3>Clickable Rows</h3>
  <div class="demo-box">
    <DataTable
      data={users}
      {columns}
      rowKey="id"
      hoverable
      onRowClick={handleRowClick}
    />
  </div>

  <h3>Loading State</h3>
  <div class="demo-box">
    <button class="btn-primary" onclick={toggleLoading}>Toggle Loading</button>
    <div style="margin-top: 16px;">
      <DataTable
        data={users}
        {columns}
        rowKey="id"
        {loading}
      />
    </div>
  </div>

  <h3>Empty State</h3>
  <div class="demo-box">
    <DataTable
      data={[]}
      {columns}
      rowKey="id"
    />
  </div>

  <h3>Striped & Dense</h3>
  <div class="demo-box">
    <DataTable
      data={users}
      {columns}
      rowKey="id"
      striped
      dense
    />
  </div>

  <h3>Size Variants</h3>
  <h4>Small</h4>
  <div class="demo-box">
    <DataTable
      data={users.slice(0, 3)}
      {columns}
      rowKey="id"
      size="sm"
    />
  </div>

  <h4>Large</h4>
  <div class="demo-box">
    <DataTable
      data={users.slice(0, 3)}
      {columns}
      rowKey="id"
      size="lg"
    />
  </div>

  <h3>Sticky Header</h3>
  <div class="demo-box scrollable">
    <DataTable
      data={[...users, ...users, ...users]}
      {columns}
      rowKey={(row, i) => `${row.id}-${i}`}
      stickyHeader
    />
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>data</code></td><td><code>T[]</code></td><td>required</td><td>Array of data objects</td></tr>
      <tr><td><code>columns</code></td><td><code>DataTableColumn[]</code></td><td>required</td><td>Column definitions</td></tr>
      <tr><td><code>rowKey</code></td><td><code>string | Function</code></td><td>-</td><td>Unique key for each row</td></tr>
      <tr><td><code>selectable</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Enable row selection</td></tr>
      <tr><td><code>selected</code></td><td><code>Set</code></td><td>-</td><td>Selected row keys (bindable)</td></tr>
      <tr><td><code>sortable</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Enable column sorting</td></tr>
      <tr><td><code>sort</code></td><td><code>SortState</code></td><td>-</td><td>Current sort state (bindable)</td></tr>
      <tr><td><code>loading</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Show loading indicator</td></tr>
      <tr><td><code>hoverable</code></td><td><code>boolean</code></td><td><code>true</code></td><td>Highlight rows on hover</td></tr>
      <tr><td><code>striped</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Alternate row colors</td></tr>
      <tr><td><code>dense</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Compact row padding</td></tr>
      <tr><td><code>stickyHeader</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Fix header when scrolling</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
      <tr><td><code>onRowClick</code></td><td><code>Function</code></td><td>-</td><td>Row click handler</td></tr>
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
    font-size: 0.8rem;
    color: var(--smrt-color-on-surface-variant);
    margin: 16px 0 8px;
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
    overflow-x: auto;
  }

  .demo-box.scrollable {
    max-height: 300px;
    overflow-y: auto;
  }

  .state-display {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin-top: 8px;
    font-family: monospace;
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

  .props-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
    margin-top: 8px;
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
