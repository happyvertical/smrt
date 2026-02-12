<script lang="ts">
import { RoleBadge } from '@happyvertical/smrt-svelte';

// Mock roles
const roles = [
  { id: '1', name: 'Owner', slug: 'owner' },
  { id: '2', name: 'Admin', slug: 'admin' },
  { id: '3', name: 'Member', slug: 'member' },
  { id: '4', name: 'Viewer', slug: 'viewer' },
  { id: '5', name: 'Custom Role', slug: 'custom' },
];

const sizes = ['sm', 'md', 'lg'] as const;
</script>

<h1>RoleBadge</h1>
<p class="description">Displays a color-coded badge for user roles.</p>

<section>
  <h2>Role Types</h2>
  <div class="demo-row">
    {#each roles as role}
      <RoleBadge {role} />
    {/each}
  </div>
</section>

<section>
  <h2>Sizes</h2>
  <div class="demo-row">
    {#each sizes as size}
      <div class="demo-item">
        <RoleBadge role={roles[1]} {size} />
        <span class="label">{size}</span>
      </div>
    {/each}
  </div>
</section>

<section>
  <h2>Props</h2>
  <table class="props-table">
    <thead>
      <tr>
        <th>Prop</th>
        <th>Type</th>
        <th>Default</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>role</code></td>
        <td><code>Role</code></td>
        <td>required</td>
        <td>Role object with name and slug</td>
      </tr>
      <tr>
        <td><code>size</code></td>
        <td><code>'sm' | 'md' | 'lg'</code></td>
        <td><code>'md'</code></td>
        <td>Badge size</td>
      </tr>
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
    margin-bottom: 40px;
  }

  h2 {
    font-size: 1rem;
    color: var(--smrt-color-on-surface);
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .demo-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .demo-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .label {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .props-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
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
