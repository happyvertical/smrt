<script lang="ts">
/**
 * AssemblyList — a table of assemblies: name, part reference, SKU codes,
 * price, labour estimate and the version of the active bill. Presentational:
 * the host loads assemblies, their SKUs and active bills, and adapts each row
 * with `toAssemblyView`.
 *
 * Pass the resolved field `policy` for Assembly (any object whose `fields`
 * name each field's `visibility`) to apply the consumer's field policy: a field the policy hides (price, for
 * a viewer who may not see it) drops its column.
 */

import { Button, CurrencyDisplay } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type AssemblyFieldPolicy,
  type AssemblyView,
  splitLabourMinutes,
} from '../types.js';

const { t } = useI18n();

export interface AssemblyListProps {
  /** Assemblies to show, in the host's order. */
  assemblies: AssemblyView[];
  /** The resolved field policy for Assembly; hidden fields drop their column. */
  policy?: AssemblyFieldPolicy;
  /** ISO 4217 currency of the prices. */
  currency?: string;
  /** Invoked with the assembly id when a name is activated. */
  onselect?: (id: string) => void;
  /** Message shown when there are no assemblies. */
  emptyMessage?: string;
}

const {
  assemblies,
  policy,
  currency = 'USD',
  onselect,
  emptyMessage,
}: AssemblyListProps = $props();

// Columns that map to Assembly fields follow the policy; SKU and bill are
// computed from neighbours and always show. When the policy hides the name,
// the row header falls back to the SKU codes, then the part reference.
const POLICY_COLUMNS = [
  { id: 'name' },
  { id: 'partReference' },
  { id: 'sku' },
  { id: 'price' },
  { id: 'labour' },
  { id: 'bill' },
];
const FIELD_BY_COLUMN: Record<string, string> = {
  labour: 'estimatedLabourMinutes',
};

const visible = $derived(
  new Set(
    POLICY_COLUMNS.filter(
      (column) =>
        policy?.fields[FIELD_BY_COLUMN[column.id] ?? column.id]?.visibility !==
        'hidden',
    ).map((column) => column.id),
  ),
);

/** The row header: the name, or a visible identifier when the name is hidden. */
function rowLabel(assembly: AssemblyView): string {
  if (visible.has('name')) return assembly.name;
  if (assembly.skuCodes.length > 0) return assembly.skuCodes.join(', ');
  if (visible.has('partReference') && assembly.partReference)
    return assembly.partReference;
  return t(M['manufacturing.assembly_list.unnamed']);
}

function labour(minutes: number): string {
  if (!minutes || minutes <= 0)
    return t(M['manufacturing.labour.not_estimated']);
  const split = splitLabourMinutes(minutes);
  return split.hours === 0
    ? t(M['manufacturing.labour.minutes'], { minutes: split.minutes })
    : t(M['manufacturing.labour.hours_minutes'], split);
}
</script>

{#if assemblies.length === 0}
  <p class="smrt-assembly-list__empty" data-smrt-component="AssemblyList">
    {emptyMessage ?? t(M['manufacturing.assembly_list.empty'])}
  </p>
{:else}
  <div class="smrt-assembly-list__root" data-smrt-component="AssemblyList">
    <table class="smrt-assembly-list__table" data-smrt-part="table">
      <caption class="smrt-assembly-list__caption" data-smrt-part="caption">{t(M['manufacturing.assembly_list.caption'])}</caption>
      <thead>
        <tr>
          <th scope="col">
            {t(
              visible.has('name')
                ? M['manufacturing.assembly_list.name']
                : M['manufacturing.assembly_list.assembly'],
            )}
          </th>
          {#if visible.has('partReference')}
            <th scope="col">{t(M['manufacturing.assembly_list.part_reference'])}</th>
          {/if}
          {#if visible.has('sku')}
            <th scope="col">{t(M['manufacturing.assembly_list.sku'])}</th>
          {/if}
          {#if visible.has('price')}
            <th scope="col" class="smrt-assembly-list__numeric" data-smrt-part="cell">{t(M['manufacturing.assembly_list.price'])}</th>
          {/if}
          {#if visible.has('labour')}
            <th scope="col" class="smrt-assembly-list__numeric" data-smrt-part="cell">{t(M['manufacturing.assembly_list.labour'])}</th>
          {/if}
          {#if visible.has('bill')}
            <th scope="col">{t(M['manufacturing.assembly_list.bill'])}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each assemblies as assembly (assembly.id)}
          <tr>
            <th scope="row" class="smrt-assembly-list__name" data-smrt-part="name">
              {#if onselect}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => onselect(assembly.id)}
                  aria-label={t(M['manufacturing.assembly_list.select_aria'], { name: rowLabel(assembly) })}
                >
                  {rowLabel(assembly)}
                </Button>
              {:else}
                {rowLabel(assembly)}
              {/if}
            </th>
            {#if visible.has('partReference')}
              <td>
                {#if assembly.partReference}
                  {assembly.partReference}
                {:else}
                  <span class="smrt-assembly-list__none" data-smrt-part="empty">{t(M['manufacturing.assembly_list.none'])}</span>
                {/if}
              </td>
            {/if}
            {#if visible.has('sku')}
              <td class="smrt-assembly-list__code" data-smrt-part="code">
                {#if assembly.skuCodes.length > 0}
                  {assembly.skuCodes.join(', ')}
                {:else}
                  <span class="smrt-assembly-list__none" data-smrt-part="empty">{t(M['manufacturing.assembly_list.none'])}</span>
                {/if}
              </td>
            {/if}
            {#if visible.has('price')}
              <td class="smrt-assembly-list__numeric" data-smrt-part="cell">
                <CurrencyDisplay amount={assembly.price} {currency} unit="cents" size="sm" />
              </td>
            {/if}
            {#if visible.has('labour')}
              <td class="smrt-assembly-list__numeric" data-smrt-part="cell">{labour(assembly.estimatedLabourMinutes)}</td>
            {/if}
            {#if visible.has('bill')}
              <td>
                {#if assembly.activeBomVersion !== null}
                  {t(M['manufacturing.assembly_list.bill_active'], { version: assembly.activeBomVersion })}
                {:else}
                  <span class="smrt-assembly-list__none" data-smrt-part="empty">{t(M['manufacturing.assembly_list.bill_missing'])}</span>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-assembly-list__root {
    overflow-x: auto;
  }
  .smrt-assembly-list__table {
    width: 100%;
  }
  .smrt-assembly-list__caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .smrt-assembly-list__table th,
  .smrt-assembly-list__table td {
    padding: 0.5rem 0.75rem;
  }
  .smrt-assembly-list__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-assembly-list__table {
    border-collapse: collapse;
  }
  .smrt-assembly-list__table th,
  .smrt-assembly-list__table td {
    text-align: left;
    border-bottom: var(--smrt-hairline);
  }
  .smrt-assembly-list__table thead th {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-label-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-assembly-list__table .smrt-assembly-list__numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .smrt-assembly-list__name {
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }
  .smrt-assembly-list__code {
    font-variant-numeric: tabular-nums;
  }
  .smrt-assembly-list__none,
  .smrt-assembly-list__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
