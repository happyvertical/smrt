<script lang="ts">
import Checkbox from '../forms/Checkbox.svelte';
import Input from '../forms/Input.svelte';

export interface PermissionPickerItem {
  id?: string;
  slug: string;
  name?: string;
  description?: string;
  category?: string;
}

export interface Props {
  /** Permission catalog the host has authorized this actor to assign. */
  permissions: readonly PermissionPickerItem[];
  /** Permission slugs checked on first render or a server-validation retry. */
  selected?: readonly string[];
  /** Repeated native form field name. */
  name?: string;
  /** Visible label for the catalog. */
  label?: string;
  /** Supporting text below the label. */
  description?: string;
  /** Accessible label and placeholder for the progressive search. */
  searchLabel?: string;
  /** Prevents changes and native form submission while retaining readable state. */
  disabled?: boolean;
}

interface PermissionGroup {
  id: string;
  label: string;
  items: readonly PermissionPickerItem[];
}

let {
  permissions,
  selected = [],
  name = 'permission',
  label = 'Permissions',
  description,
  searchLabel = 'Search permissions',
  disabled = false,
}: Props = $props();

let query = $state('');
let localSelection = $state.raw<{
  source: readonly string[];
  slugs: Set<string>;
} | null>(null);
const instanceId = $props.id();
const labelId = `permission-picker-label-${instanceId}`;
const selectedSlugs = $derived(new Set(selected));
const currentSelectedSlugs = $derived(
  localSelection?.source === selected ? localSelection.slugs : selectedSlugs,
);
const normalizedQuery = $derived(normalize(query));
const groups = $derived(groupPermissions(permissions));
const visibleCount = $derived(
  groups.reduce(
    (count, group) =>
      count +
      group.items.filter((permission) => matches(permission, group.label))
        .length,
    0,
  ),
);

function updateSelection(slug: string, checked: boolean): void {
  const next = new Set(currentSelectedSlugs);
  if (checked) next.add(slug);
  else next.delete(slug);
  localSelection = { source: selected, slugs: next };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function words(value: string): string {
  const spaced = value
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced
    ? spaced.charAt(0).toLocaleUpperCase() + spaced.slice(1)
    : 'Other';
}

function categoryOf(permission: PermissionPickerItem): string {
  const category = permission.category?.trim();
  if (category) return category;
  return words(permission.slug.split('.')[0] ?? '');
}

function groupPermissions(
  catalog: readonly PermissionPickerItem[],
): PermissionGroup[] {
  const byCategory = new Map<string, PermissionPickerItem[]>();
  for (const permission of catalog) {
    const category = categoryOf(permission);
    const group = byCategory.get(category) ?? [];
    group.push(permission);
    byCategory.set(category, group);
  }
  return [...byCategory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, items], index) => ({
      id: `permission-group-${index}`,
      label: category,
      items: [...items].sort((left, right) =>
        left.slug.localeCompare(right.slug),
      ),
    }));
}

function displayName(permission: PermissionPickerItem): string {
  return permission.name?.trim() || words(permission.slug);
}

function matches(permission: PermissionPickerItem, category: string): boolean {
  if (!normalizedQuery) return true;
  return normalize(
    [
      displayName(permission),
      permission.slug,
      permission.description ?? '',
      category,
    ].join(' '),
  ).includes(normalizedQuery);
}
</script>

<section class="permission-picker" aria-labelledby={labelId}>
  <div class="heading">
    <div>
      <h2 id={labelId}>{label}</h2>
      {#if description}<p>{description}</p>{/if}
    </div>
    <label class="search">
      <span>{searchLabel}</span>
      <Input
        type="search"
        value={query}
        oninput={(event) => (query = event.currentTarget.value)}
        placeholder={searchLabel}
        autocomplete="off"
      />
    </label>
  </div>

  {#key selected}
  <fieldset {disabled}>
    <legend class="visually-hidden">{label}</legend>
    <div class="groups">
      {#each groups as group (group.label)}
        {@const groupVisible = group.items.some((permission) => matches(permission, group.label))}
        {@const selectedCount = group.items.filter((permission) => currentSelectedSlugs.has(permission.slug)).length}
        <details class="group" open={normalizedQuery ? groupVisible : undefined} hidden={!groupVisible}>
          <summary id={group.id}>
            <span>{group.label}</span>
            <span class="selected-count">{selectedCount} selected</span>
          </summary>
          <div class="choices">
            {#each group.items as permission (permission.id ?? permission.slug)}
              <div class="choice" hidden={!matches(permission, group.label)}>
                <Checkbox
                  {name}
                  value={permission.slug}
                  checked={selectedSlugs.has(permission.slug)}
                  onchange={(event) => updateSelection(permission.slug, event.currentTarget.checked)}
                  label={displayName(permission)}
                  {disabled}
                />
                <code>{permission.slug}</code>
                {#if permission.description}<p>{permission.description}</p>{/if}
              </div>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  </fieldset>
  {/key}

  {#if normalizedQuery && visibleCount === 0}
    <p class="no-results" role="status">No permissions match “{query.trim()}”.</p>
  {/if}
</section>

<style>
  .permission-picker { display: grid; gap: var(--smrt-spacing-4); min-inline-size: 0; }
  .heading { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--smrt-spacing-4); }
  h2, p { margin: 0; }
  h2 { color: var(--smrt-color-on-surface); font: var(--smrt-typography-title-large-font); }
  .heading p, .choice p, code, .no-results { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-body-small-font); }
  .heading p { margin-block-start: var(--smrt-spacing-1); }
  .search { display: grid; flex: 1 1 16rem; max-inline-size: 28rem; gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); font: var(--smrt-typography-label-medium-font); }
  fieldset { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
  .groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr)); gap: var(--smrt-spacing-4); align-items: start; }
  .group { min-inline-size: 0; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); }
  summary { display: flex; min-block-size: 2.75rem; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-3) var(--smrt-spacing-4); color: var(--smrt-color-on-surface); font: var(--smrt-typography-title-medium-font); cursor: pointer; }
  summary:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .selected-count { flex: 0 0 auto; color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-medium-font); }
  .choices { display: grid; gap: var(--smrt-spacing-4); padding: 0 var(--smrt-spacing-4) var(--smrt-spacing-4); border-block-start: 1px solid var(--smrt-color-outline-variant); padding-block-start: var(--smrt-spacing-4); }
  .choice { display: grid; min-inline-size: 0; gap: var(--smrt-spacing-1); }
  .choice :global(.checkbox) { min-inline-size: 0; }
  .choice :global(.checkbox__label), code, .choice p { overflow-wrap: anywhere; }
  code { padding-inline-start: calc(1.125rem + var(--smrt-spacing-2)); }
  .choice p { padding-inline-start: calc(1.125rem + var(--smrt-spacing-2)); }
  .no-results { padding: var(--smrt-spacing-4); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface-container-low); }
  .visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  [hidden] { display: none; }
</style>
