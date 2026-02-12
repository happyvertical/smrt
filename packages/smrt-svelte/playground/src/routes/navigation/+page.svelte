<script lang="ts">
import type { FilterOption, Tab } from '@happyvertical/smrt-svelte';
import { FilterChips, Tabs } from '@happyvertical/smrt-svelte';

// Filter options for demo
const statusFilters: FilterOption[] = [
  { value: 'active', label: 'Active', count: 12 },
  { value: 'pending', label: 'Pending', count: 5 },
  { value: 'completed', label: 'Completed', count: 28 },
  { value: 'archived', label: 'Archived', count: 15 },
];

const projectFilters: FilterOption[] = [
  { value: 'design', label: 'Design', count: 8 },
  { value: 'development', label: 'Development', count: 15 },
  { value: 'marketing', label: 'Marketing', count: 6 },
  { value: 'other', label: 'Other', disabled: true },
];

// Tab options for demo
const mainTabs: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'details', label: 'Details' },
  { id: 'history', label: 'History', count: 24 },
  { id: 'settings', label: 'Settings' },
];

const projectTabs: Tab[] = [
  { id: 'all', label: 'All Projects', count: 45 },
  { id: 'active', label: 'Active', count: 12 },
  { id: 'completed', label: 'Completed', count: 28 },
  { id: 'archived', label: 'Archived', disabled: true },
];

// State
let selectedStatus = $state('active');
let selectedProject = $state('development');
let activeTab = $state('overview');
let activeProjectTab = $state('all');
</script>

<h1>Navigation Components</h1>
<p class="description">Components for filtering and tab-based navigation.</p>

<section>
  <h2>FilterChips</h2>
  <p class="section-desc">Horizontal filter selection for list filtering.</p>

  <h3>Basic</h3>
  <div class="demo-box">
    <FilterChips
      options={statusFilters}
      selected={selectedStatus}
      onchange={(value) => selectedStatus = value}
    />
    <p class="selected-value">Selected: <code>{selectedStatus}</code></p>
  </div>

  <h3>With "All" Option</h3>
  <div class="demo-box">
    <FilterChips
      options={projectFilters}
      selected={selectedProject}
      onchange={(value) => selectedProject = value}
      showAll
      allLabel="All Types"
    />
    <p class="selected-value">Selected: <code>{selectedProject || 'all'}</code></p>
  </div>

  <h3>Small Size</h3>
  <div class="demo-box">
    <FilterChips
      options={statusFilters}
      selected={selectedStatus}
      onchange={(value) => selectedStatus = value}
      size="sm"
    />
  </div>
</section>

<section>
  <h2>Tabs</h2>
  <p class="section-desc">Tab navigation with optional counts and content.</p>

  <h3>Underline Variant (Default)</h3>
  <div class="demo-box">
    <Tabs
      tabs={mainTabs}
      active={activeTab}
      onchange={(id) => activeTab = id}
    />
    <div class="tab-content-demo">
      Content for <strong>{activeTab}</strong> tab
    </div>
  </div>

  <h3>Pills Variant</h3>
  <div class="demo-box">
    <Tabs
      tabs={projectTabs}
      active={activeProjectTab}
      onchange={(id) => activeProjectTab = id}
      variant="pills"
    />
    <div class="tab-content-demo">
      Showing <strong>{activeProjectTab}</strong> projects
    </div>
  </div>

  <h3>Sizes</h3>
  <div class="demo-col">
    <div class="demo-box">
      <span class="size-label">sm:</span>
      <Tabs tabs={mainTabs.slice(0, 3)} active="overview" size="sm" />
    </div>
    <div class="demo-box">
      <span class="size-label">md:</span>
      <Tabs tabs={mainTabs.slice(0, 3)} active="overview" size="md" />
    </div>
    <div class="demo-box">
      <span class="size-label">lg:</span>
      <Tabs tabs={mainTabs.slice(0, 3)} active="overview" size="lg" />
    </div>
  </div>

  <h3>With Content Slot</h3>
  <div class="demo-box">
    <Tabs
      tabs={mainTabs}
      active={activeTab}
      onchange={(id) => activeTab = id}
    >
      {#if activeTab === 'overview'}
        <div class="content-panel">
          <h4>Overview</h4>
          <p>This is the overview content rendered via the children slot.</p>
        </div>
      {:else if activeTab === 'details'}
        <div class="content-panel">
          <h4>Details</h4>
          <p>Detailed information about this item.</p>
        </div>
      {:else if activeTab === 'history'}
        <div class="content-panel">
          <h4>History</h4>
          <p>24 history items to review.</p>
        </div>
      {:else}
        <div class="content-panel">
          <h4>Settings</h4>
          <p>Configure your preferences here.</p>
        </div>
      {/if}
    </Tabs>
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>FilterChips</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>options</code></td><td><code>FilterOption[]</code></td><td>required</td><td>Filter options array</td></tr>
      <tr><td><code>selected</code></td><td><code>string</code></td><td>required</td><td>Currently selected value</td></tr>
      <tr><td><code>onchange</code></td><td><code>(value: string) => void</code></td><td>-</td><td>Selection change handler</td></tr>
      <tr><td><code>showAll</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Show "All" option</td></tr>
      <tr><td><code>allLabel</code></td><td><code>string</code></td><td><code>'All'</code></td><td>All option label</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
    </tbody>
  </table>

  <h3>FilterOption Type</h3>
  <table class="props-table">
    <thead>
      <tr><th>Property</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>value</code></td><td><code>string</code></td><td>Option value</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>Display label</td></tr>
      <tr><td><code>count</code></td><td><code>number</code></td><td>Optional count badge</td></tr>
      <tr><td><code>disabled</code></td><td><code>boolean</code></td><td>Disabled state</td></tr>
    </tbody>
  </table>

  <h3>Tabs</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>tabs</code></td><td><code>Tab[]</code></td><td>required</td><td>Tab definitions</td></tr>
      <tr><td><code>active</code></td><td><code>string</code></td><td>required</td><td>Active tab id</td></tr>
      <tr><td><code>onchange</code></td><td><code>(id: string) => void</code></td><td>-</td><td>Tab change handler</td></tr>
      <tr><td><code>variant</code></td><td><code>'underline' | 'pills'</code></td><td><code>'underline'</code></td><td>Visual variant</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
      <tr><td><code>children</code></td><td><code>Snippet</code></td><td>-</td><td>Tab content slot</td></tr>
    </tbody>
  </table>

  <h3>Tab Type</h3>
  <table class="props-table">
    <thead>
      <tr><th>Property</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>id</code></td><td><code>string</code></td><td>Tab identifier</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>Display label</td></tr>
      <tr><td><code>count</code></td><td><code>number</code></td><td>Optional count badge</td></tr>
      <tr><td><code>disabled</code></td><td><code>boolean</code></td><td>Disabled state</td></tr>
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
    margin: 0 0 8px;
    color: var(--smrt-color-on-surface);
  }

  .section-desc {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
    margin-bottom: 16px;
  }

  .demo-box {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .demo-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .selected-value {
    margin-top: 12px;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .tab-content-demo {
    margin-top: 16px;
    padding: 16px;
    background: var(--smrt-color-surface);
    border-radius: 6px;
    border: 1px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-surface);
  }

  .content-panel {
    padding: 16px;
    background: var(--smrt-color-surface);
    border-radius: 6px;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .content-panel p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .size-label {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 8px;
    display: block;
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
    border-radius: 4px;
    font-size: 0.8rem;
  }
</style>
