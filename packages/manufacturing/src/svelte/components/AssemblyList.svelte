<script lang="ts">
/**
 * AssemblyList — a table of assemblies: name, part reference, SKU codes,
 * price, labour estimate and the version of the active bill. Presentational:
 * the host loads assemblies, their SKUs and active bills, and adapts each row
 * with `toAssemblyView`.
 *
 * Pass the resolved field `policy` for `@happyvertical/smrt-manufacturing:Assembly`
 * to apply the consumer's field policy: a field the policy hides (price, for
 * a viewer who may not see it) drops its column.
 */

import {
  policyToVisibleColumnIds,
  type ResolvedObjectFieldPolicy,
} from '@happyvertical/smrt-fields/svelte';
import { Button, CurrencyDisplay } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import { type AssemblyView, splitLabourMinutes } from '../types.js';

const { t } = useI18n();

export interface AssemblyListProps {
  /** Assemblies to show, in the host's order. */
  assemblies: AssemblyView[];
  /** The resolved field policy for Assembly; hidden fields drop their column. */
  policy?: ResolvedObjectFieldPolicy;
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
// computed from neighbours and always show. The name is the row header and
// always shows.
const POLICY_COLUMNS = [
  { id: 'partReference' },
  { id: 'sku' },
  { id: 'price' },
  { id: 'labour' },
  { id: 'bill' },
];
const FIELD_BY_COLUMN = { labour: 'estimatedLabourMinutes' };

const visible = $derived(
  policy
    ? policyToVisibleColumnIds(policy, POLICY_COLUMNS, FIELD_BY_COLUMN)
    : new Set(POLICY_COLUMNS.map((column) => column.id)),
);

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
  <p class="assembly-list-empty">
    {emptyMessage ?? t(M['manufacturing.assembly_list.empty'])}
  </p>
{:else}
  <div class="assembly-list-scroll">
    <table class="assembly-list">
      <caption class="assembly-list-caption">{t(M['manufacturing.assembly_list.caption'])}</caption>
      <thead>
        <tr>
          <th scope="col">{t(M['manufacturing.assembly_list.name'])}</th>
          {#if visible.has('partReference')}
            <th scope="col">{t(M['manufacturing.assembly_list.part_reference'])}</th>
          {/if}
          {#if visible.has('sku')}
            <th scope="col">{t(M['manufacturing.assembly_list.sku'])}</th>
          {/if}
          {#if visible.has('price')}
            <th scope="col" class="numeric">{t(M['manufacturing.assembly_list.price'])}</th>
          {/if}
          {#if visible.has('labour')}
            <th scope="col" class="numeric">{t(M['manufacturing.assembly_list.labour'])}</th>
          {/if}
          {#if visible.has('bill')}
            <th scope="col">{t(M['manufacturing.assembly_list.bill'])}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each assemblies as assembly (assembly.id)}
          <tr>
            <th scope="row" class="assembly-list-name">
              {#if onselect}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => onselect(assembly.id)}
                  aria-label={t(M['manufacturing.assembly_list.select_aria'], { name: assembly.name })}
                >
                  {assembly.name}
                </Button>
              {:else}
                {assembly.name}
              {/if}
            </th>
            {#if visible.has('partReference')}
              <td>
                {#if assembly.partReference}
                  {assembly.partReference}
                {:else}
                  <span class="assembly-list-none">{t(M['manufacturing.assembly_list.none'])}</span>
                {/if}
              </td>
            {/if}
            {#if visible.has('sku')}
              <td class="assembly-list-code">
                {#if assembly.skuCodes.length > 0}
                  {assembly.skuCodes.join(', ')}
                {:else}
                  <span class="assembly-list-none">{t(M['manufacturing.assembly_list.none'])}</span>
                {/if}
              </td>
            {/if}
            {#if visible.has('price')}
              <td class="numeric">
                <CurrencyDisplay amount={assembly.price} {currency} unit="cents" size="sm" />
              </td>
            {/if}
            {#if visible.has('labour')}
              <td class="numeric">{labour(assembly.estimatedLabourMinutes)}</td>
            {/if}
            {#if visible.has('bill')}
              <td>
                {#if assembly.activeBomVersion !== null}
                  {t(M['manufacturing.assembly_list.bill_active'], { version: assembly.activeBomVersion })}
                {:else}
                  <span class="assembly-list-none">{t(M['manufacturing.assembly_list.bill_missing'])}</span>
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
  .assembly-list-scroll {
    overflow-x: auto;
  }

  .assembly-list {
    width: 100%;
    border-collapse: collapse;
  }

  .assembly-list-caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .assembly-list th,
  .assembly-list td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .assembly-list thead th {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-label-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .assembly-list .numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .assembly-list-name {
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }

  .assembly-list-code {
    font-variant-numeric: tabular-nums;
  }

  .assembly-list-none,
  .assembly-list-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .assembly-list-empty {
    padding: 1rem 0;
  }
</style>
