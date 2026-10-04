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

<ul class="requirements-tree" aria-label={label}>
  {#each lines as line (line.key)}
    <li class="requirements-line" data-level={line.level}>
      <div class="requirements-row">
        <span class="requirements-component">{componentText(line)}</span>
        <Badge size="sm" variant={line.kind === 'missing' ? 'error' : 'default'}>
          {t(componentKindLabelKey(line.kind))}
        </Badge>
        <span class="requirements-qty">
          {t(M['manufacturing.requirements.required'], {
            qty: quantity(line.required),
            uom: line.uom,
          })}
        </span>
        {#if line.available !== null}
          <span class="requirements-qty">
            {t(M['manufacturing.requirements.available'], { qty: quantity(line.available) })}
          </span>
        {/if}
        {#if line.short !== null}
          {#if line.short > 0}
            <Badge size="sm" variant="error">
              {t(M['manufacturing.requirements.short'], { qty: quantity(line.short) })}
            </Badge>
          {:else}
            <span class="requirements-note">{t(M['manufacturing.requirements.covered'])}</span>
          {/if}
        {/if}
        {#if line.kind === 'assembly' && !line.buildable}
          <span class="requirements-note">{t(M['manufacturing.requirements.no_bill'])}</span>
        {:else if line.buildable && line.children.length === 0 && (line.short ?? 0) > 0}
          <span class="requirements-note">{t(M['manufacturing.requirements.buildable'])}</span>
        {/if}
      </div>
      {#if line.children.length > 0}
        <div class="requirements-children">
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
  .requirements-tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .requirements-line {
    padding: 0.25rem 0;
  }

  .requirements-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .requirements-component {
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }

  .requirements-qty {
    font-variant-numeric: tabular-nums;
  }

  .requirements-note {
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .requirements-children {
    margin-left: 1rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--smrt-color-outline-variant, transparent);
  }
</style>
