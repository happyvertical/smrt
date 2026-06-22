<script lang="ts">
/**
 * Tree — recursive, selectable tree view (generalizes the workspace NavTree).
 *
 * Renders a flat-DOM WAI-ARIA tree (`role="tree"` → `role="treeitem"` with
 * `aria-level`), which keeps full keyboard support simple: roving tabindex, Arrow
 * Up/Down to move between visible items, Right to expand / descend, Left to
 * collapse / ascend, Home/End, and Enter/Space to select.
 */
import { tick, untrack } from 'svelte';
import type { TreeNode } from '../../types-generic';

export interface Props {
  /** Root nodes. */
  nodes: TreeNode[];
  /** Selected node id. */
  selectedId?: string;
  /** Initially expanded node ids. */
  expanded?: string[];
  /** Fired with the selected node id. */
  onselect?: (id: string) => void;
  /** Accessible label for the tree. */
  'aria-label'?: string;
}

const {
  nodes,
  selectedId,
  expanded: initialExpanded = [],
  onselect,
  'aria-label': ariaLabel = 'Tree',
}: Props = $props();

// Uncontrolled: seed once from the initial prop value.
let expandedSet = $state(new Set(untrack(() => initialExpanded)));
let activeId = $state<string | null>(null);
let itemEls = $state<Array<HTMLDivElement | null>>([]);

interface FlatNode {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

const flat = $derived.by(() => {
  const out: FlatNode[] = [];
  const walk = (list: TreeNode[], depth: number) => {
    for (const node of list) {
      const hasChildren = !!node.children?.length;
      const isExpanded = expandedSet.has(node.id);
      out.push({ node, depth, hasChildren, isExpanded });
      if (hasChildren && isExpanded) walk(node.children ?? [], depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
});

// The treeitem that owns tabindex=0 — active, else selected, else first.
const tabbableId = $derived(activeId ?? selectedId ?? flat[0]?.node.id ?? null);

function setExpanded(id: string, value: boolean) {
  const next = new Set(expandedSet);
  if (value) next.add(id);
  else next.delete(id);
  expandedSet = next;
}

async function focusIndex(index: number) {
  const target = flat[index];
  if (!target) return;
  activeId = target.node.id;
  await tick();
  itemEls[index]?.focus();
}

function select(node: TreeNode) {
  activeId = node.id;
  onselect?.(node.id);
}

function onItemKeydown(event: KeyboardEvent, index: number, item: FlatNode) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusIndex(Math.min(index + 1, flat.length - 1));
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusIndex(Math.max(index - 1, 0));
      break;
    case 'ArrowRight':
      event.preventDefault();
      if (item.hasChildren && !item.isExpanded) setExpanded(item.node.id, true);
      else if (item.hasChildren) focusIndex(index + 1);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      if (item.hasChildren && item.isExpanded) {
        setExpanded(item.node.id, false);
      } else {
        // Move to parent: nearest preceding item at a shallower depth.
        for (let i = index - 1; i >= 0; i--) {
          if (flat[i].depth < item.depth) {
            focusIndex(i);
            break;
          }
        }
      }
      break;
    case 'Home':
      event.preventDefault();
      focusIndex(0);
      break;
    case 'End':
      event.preventDefault();
      focusIndex(flat.length - 1);
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (item.hasChildren) setExpanded(item.node.id, !item.isExpanded);
      select(item.node);
      break;
  }
}
</script>

<div role="tree" aria-label={ariaLabel} class="tree">
  {#each flat as item, i (item.node.id)}
    <div
      bind:this={itemEls[i]}
      role="treeitem"
      class="tree__item"
      class:selected={selectedId === item.node.id}
      style:padding-left="calc({item.depth} * var(--smrt-spacing-4, 16px) + var(--smrt-spacing-2, 8px))"
      aria-level={item.depth + 1}
      aria-selected={selectedId === item.node.id}
      aria-expanded={item.hasChildren ? item.isExpanded : undefined}
      tabindex={tabbableId === item.node.id ? 0 : -1}
      onclick={() => {
        if (item.hasChildren) setExpanded(item.node.id, !item.isExpanded);
        select(item.node);
      }}
      onkeydown={(e) => onItemKeydown(e, i, item)}
    >
      {#if item.hasChildren}
        <span class="tree__twisty" class:open={item.isExpanded} aria-hidden="true"
          >▸</span
        >
      {:else}
        <span class="tree__twisty tree__twisty--leaf" aria-hidden="true"></span>
      {/if}
      <span class="tree__label">{item.node.label}</span>
    </div>
  {/each}
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
  }

  .tree__item {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding-top: var(--smrt-spacing-1, 4px);
    padding-bottom: var(--smrt-spacing-1, 4px);
    padding-right: var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 4px);
    cursor: pointer;
    color: var(--smrt-color-on-surface);
    user-select: none;
  }
  .tree__item:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .tree__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .tree__item.selected {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .tree__twisty {
    display: inline-flex;
    width: 1em;
    justify-content: center;
    transition: transform 0.15s ease;
    font-size: 0.75em;
  }
  .tree__twisty.open {
    transform: rotate(90deg);
  }
  .tree__twisty--leaf {
    visibility: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .tree__twisty {
      transition: none;
    }
  }
</style>
