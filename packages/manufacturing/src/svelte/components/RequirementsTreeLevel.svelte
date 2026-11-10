<script lang="ts">
/**
 * One level of `RequirementsTree`: a list of lines, each followed by the
 * lines of its sub-assembly's bill when the walk opened it. Internal to
 * `RequirementsTree`.
 */

import { Badge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import { componentKindLabelKey, type RequirementLineView } from '../types.js';
import RequirementsTreeLevel from './RequirementsTreeLevel.svelte';

const { t } = useI18n();

export interface RequirementsTreeLevelProps {
  /** The lines of this level. */
  lines: RequirementLineView[];
  /** Accessible name for the list. */
  label: string;
}

const { lines, label }: RequirementsTreeLevelProps = $props();

function quantity(value: number): string {
  return String(Number(value.toFixed(6)));
}

function componentText(line: RequirementLineView): string {
  const shown = line.name || t(M['manufacturing.requirements.unnamed']);
  return line.skuCode && line.skuCode !== line.name
    ? `${shown} (${line.skuCode})`
    : shown;
}
</script>

<ul class="smrt-requirements-tree-level__tree"  aria-label={label} data-smrt-component="RequirementsTreeLevel">
  {#each lines as line (line.key)}
    <li class="smrt-requirements-tree-level__line" data-smrt-part="item" data-level={line.level}>
      <div class="smrt-requirements-tree-level__row" data-smrt-part="row">
        <span class="smrt-requirements-tree-level__component" data-smrt-part="title">{componentText(line)}</span>
        <Badge size="sm" variant={line.kind === 'missing' ? 'error' : 'default'}>
          {t(componentKindLabelKey(line.kind))}
        </Badge>
        <span class="smrt-requirements-tree-level__qty" data-smrt-part="value">
          {t(M['manufacturing.requirements.required'], {
            qty: quantity(line.required),
            uom: line.uom,
          })}
        </span>
        {#if line.available !== null}
          <span class="smrt-requirements-tree-level__qty" data-smrt-part="value">
            {t(M['manufacturing.requirements.available'], { qty: quantity(line.available) })}
          </span>
        {/if}
        {#if line.short !== null}
          {#if line.short > 0}
            <Badge size="sm" variant="error">
              {t(M['manufacturing.requirements.short'], { qty: quantity(line.short) })}
            </Badge>
          {:else}
            <span class="smrt-requirements-tree-level__note" data-smrt-part="description">{t(M['manufacturing.requirements.covered'])}</span>
          {/if}
        {/if}
        {#if line.kind === 'assembly' && !line.buildable}
          <span class="smrt-requirements-tree-level__note" data-smrt-part="description">{t(M['manufacturing.requirements.no_bill'])}</span>
        {:else if line.buildable && line.children.length === 0 && (line.short ?? 0) > 0}
          <span class="smrt-requirements-tree-level__note" data-smrt-part="description">{t(M['manufacturing.requirements.buildable'])}</span>
        {/if}
      </div>
      {#if line.children.length > 0}
        <div class="smrt-requirements-tree-level__children" data-smrt-part="list">
          <RequirementsTreeLevel
            lines={line.children}
            label={t(M['manufacturing.requirements.sub_label'], {
              component: line.name || t(M['manufacturing.requirements.unnamed']),
            })}
          />
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-requirements-tree-level__tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-requirements-tree-level__line {
    padding: 0.25rem 0;
  }
  .smrt-requirements-tree-level__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-requirements-tree-level__children {
    margin-left: 1rem;
    padding-left: 0.75rem;
  }
}

@layer smrt.theme {
  .smrt-requirements-tree-level__component {
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }
  .smrt-requirements-tree-level__qty {
    font-variant-numeric: tabular-nums;
  }
  .smrt-requirements-tree-level__note {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-requirements-tree-level__children {
    border-left: 2px solid var(--smrt-color-outline-variant, transparent);
  }
}

</style>
