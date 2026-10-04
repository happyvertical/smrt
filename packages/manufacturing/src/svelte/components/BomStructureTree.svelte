<script lang="ts">
/**
 * BomStructureTree — a read-only view of one level of a bill: each line's
 * component, kind, quantity and unit. A sub-assembly with its own active bill
 * can be expanded to show that bill, loaded through `loadBill`, to any depth.
 *
 * Used by `BomEditor` to show a sub-assembly's structure without making it
 * editable there; a sub-assembly's bill is edited on its own assembly.
 */

import { Badge, Button } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import { type BomEditorLine, componentKindLabelKey } from '../types.js';
import BomStructureTree from './BomStructureTree.svelte';

const { t } = useI18n();

export interface BomStructureTreeProps {
  /** The lines of this level. */
  lines: BomEditorLine[];
  /** Loads a sub-assembly's bill lines by bill id. */
  loadBill?: (bomId: string) => Promise<BomEditorLine[]>;
  /** Bill ids already open above this level; never opened again. */
  ancestors?: readonly string[];
  /** Accessible name for the list. */
  label: string;
}

const {
  lines,
  loadBill,
  ancestors = [],
  label,
}: BomStructureTreeProps = $props();

const uid = $props.id();

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; lines: BomEditorLine[] }
  | { state: 'failed' };

let open = $state<Record<string, boolean>>({});
let loaded = $state<Record<string, Loaded>>({});

function componentText(line: BomEditorLine): string {
  return line.skuCode && line.skuCode !== line.componentName
    ? `${line.componentName} (${line.skuCode})`
    : line.componentName;
}

async function toggle(line: BomEditorLine) {
  const bomId = line.subBomId;
  if (!bomId || !loadBill) return;
  open[line.id] = !open[line.id];
  if (!open[line.id] || loaded[bomId]?.state === 'ready') return;
  loaded[bomId] = { state: 'loading' };
  try {
    loaded[bomId] = { state: 'ready', lines: await loadBill(bomId) };
  } catch {
    loaded[bomId] = { state: 'failed' };
  }
}
</script>

<ul class="bom-tree" aria-label={label}>
  {#each lines as line (line.id)}
    {@const canOpen =
      line.kind === 'assembly' &&
      line.subBomId !== null &&
      loadBill !== undefined &&
      !ancestors.includes(line.subBomId)}
    {@const subId = `${uid}-${line.id}`}
    <li class="bom-tree-line">
      <div class="bom-tree-row">
        <span class="bom-tree-component">{componentText(line)}</span>
        <Badge size="sm" variant={line.kind === 'missing' ? 'error' : 'default'}>
          {t(componentKindLabelKey(line.kind))}
        </Badge>
        <span class="bom-tree-qty">{line.qtyPerUnit} {line.uom}</span>
        {#if line.kind === 'assembly' && line.subBomId === null}
          <span class="bom-tree-note">{t(M['manufacturing.bom_editor.no_bill'])}</span>
        {/if}
        {#if canOpen}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open[line.id] ? 'true' : 'false'}
            aria-controls={subId}
            aria-label={t(
              open[line.id]
                ? M['manufacturing.bom_editor.hide_bill_aria']
                : M['manufacturing.bom_editor.show_bill_aria'],
              { component: line.componentName },
            )}
            onclick={() => toggle(line)}
          >
            {t(
              open[line.id]
                ? M['manufacturing.bom_editor.hide_bill']
                : M['manufacturing.bom_editor.show_bill'],
            )}
          </Button>
        {/if}
      </div>
      {#if canOpen && open[line.id] && line.subBomId}
        {@const entry = loaded[line.subBomId]}
        <div id={subId} class="bom-tree-children">
          {#if entry?.state === 'ready'}
            <BomStructureTree
              lines={entry.lines}
              {loadBill}
              ancestors={[...ancestors, line.subBomId]}
              label={t(M['manufacturing.bom_editor.sub_bill_label'], { component: line.componentName })}
            />
          {:else if entry?.state === 'failed'}
            <p class="bom-tree-note" role="alert">{t(M['manufacturing.bom_editor.load_failed'])}</p>
          {:else}
            <p class="bom-tree-note" role="status">{t(M['manufacturing.bom_editor.loading'])}</p>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .bom-tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .bom-tree-line {
    padding: 0.25rem 0;
  }

  .bom-tree-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .bom-tree-component {
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }

  .bom-tree-qty {
    font-variant-numeric: tabular-nums;
  }

  .bom-tree-note {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .bom-tree-children {
    margin-left: 1rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--smrt-color-outline-variant, transparent);
  }
</style>
