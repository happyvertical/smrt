<script lang="ts">
import {
  Avatar,
  Chip,
  Dropdown,
  Skeleton,
  Tooltip,
  Tree,
} from '@happyvertical/smrt-svelte';

let selected = $state<Record<string, boolean>>({ ts: true, svelte: false });
let chips = $state(['Design', 'A11y', 'Tokens']);
let lastAction = $state('—');
let selectedNode = $state('a');

function toggle(key: string) {
  selected[key] = !selected[key];
}
function removeChip(name: string) {
  chips = chips.filter((c) => c !== name);
}

const menuItems = [
  { id: 'edit', label: 'Edit' },
  { id: 'dup', label: 'Duplicate' },
  { id: 'del', label: 'Delete', disabled: true },
];

const treeNodes = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'a', label: 'app.ts' },
      {
        id: 'components',
        label: 'components',
        children: [{ id: 'btn', label: 'Button.svelte' }],
      },
    ],
  },
  { id: 'readme', label: 'README.md' },
];
</script>

<h1>Gap Primitives</h1>
<p class="description">
  Generic library primitives (L3 #1422) — Avatar, Chip, Skeleton, Tooltip,
  Dropdown, Tree.
</p>

<section>
  <h2>Avatar</h2>
  <p class="section-desc">Image with initials fallback + optional presence dot.</p>
  <div class="demo-row">
    <Avatar name="Ada Lovelace" size="sm" />
    <Avatar name="Grace Hopper" size="md" status="online" />
    <Avatar name="Linus Torvalds" size="lg" status="busy" />
    <Avatar name="Margaret Hamilton" size="xl" status="away" />
  </div>
</section>

<section>
  <h2>Chip</h2>
  <p class="section-desc">Selectable toggles and closeable tokens.</p>
  <div class="demo-row">
    <Chip
      label="TypeScript"
      selectable
      selected={selected.ts}
      onselect={() => toggle('ts')}
    />
    <Chip
      label="Svelte"
      selectable
      selected={selected.svelte}
      onselect={() => toggle('svelte')}
    />
  </div>
  <div class="demo-row">
    {#each chips as chip (chip)}
      <Chip label={chip} closeable onclose={() => removeChip(chip)} />
    {/each}
  </div>
</section>

<section>
  <h2>Skeleton</h2>
  <p class="section-desc">Shape-matching loading placeholders.</p>
  <div class="demo-row" style="align-items: center; gap: 16px;">
    <Skeleton variant="circle" />
    <div style="flex: 1;">
      <Skeleton variant="text" lines={3} />
    </div>
  </div>
  <div class="demo-row">
    <Skeleton variant="rect" width="240px" height="120px" />
  </div>
</section>

<section>
  <h2>Tooltip</h2>
  <p class="section-desc">Anchored, delayed, placement-aware.</p>
  <div class="demo-row" style="gap: 24px;">
    <Tooltip text="Top tooltip" placement="top">
      <button type="button">Hover me (top)</button>
    </Tooltip>
    <Tooltip text="Right tooltip" placement="right">
      <button type="button">Hover me (right)</button>
    </Tooltip>
  </div>
</section>

<section>
  <h2>Dropdown / Menu</h2>
  <p class="section-desc">Trigger + positioned, keyboard-navigable menu.</p>
  <div class="demo-row">
    <Dropdown
      label="Actions ▾"
      items={menuItems}
      onselect={(id) => (lastAction = id)}
    />
    <span class="section-desc">Last action: <code>{lastAction}</code></span>
  </div>
</section>

<section>
  <h2>Tree</h2>
  <p class="section-desc">Recursive, selectable, full keyboard nav.</p>
  <div class="demo-row" style="max-width: 320px;">
    <div style="flex: 1;">
      <Tree
        nodes={treeNodes}
        expanded={['src']}
        selectedId={selectedNode}
        aria-label="Project files"
        onselect={(id) => (selectedNode = id)}
      />
    </div>
  </div>
</section>

<style>
  .description {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-bottom: 2rem;
  }
  section {
    margin-bottom: 2.5rem;
  }
  .section-desc {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
  }
  .demo-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 0.75rem;
  }
</style>
