<script lang="ts">
import type { Snippet } from 'svelte';
import type {
  FieldPolicyDetailItem,
  FieldPolicySettingsCatalogPage,
} from '../../../settings-catalog.js';

interface Props {
  page: FieldPolicySettingsCatalogPage;
  baseUrl: string;
  detail: Snippet<[{ item: FieldPolicyDetailItem }]>;
  preservedParams?: Record<string, string>;
}

let { page, baseUrl, detail, preservedParams = {} }: Props = $props();
const href = $derived(
  `${baseUrl}?${new URLSearchParams(preservedParams).toString()}`,
);
</script>

<a aria-label="catalog navigation" {href}>Catalog navigation</a>
{#if page.selected}
  {@render detail({ item: page.selected })}
{/if}
