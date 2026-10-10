<script lang="ts">
import type { Cookbook } from '@happyvertical/smrt-types';
import CookbookApp from '../CookbookApp.svelte';
import CookbookSectionPage from '../CookbookSectionPage.svelte';
import { getCookbookContext } from '../context.js';
import type { CookbookCatalog } from '../types.js';

interface Props {
  cookbook: Cookbook;
  catalog: CookbookCatalog;
  sectionId: string;
  oncookbookchange?: (cookbook: Cookbook) => void;
  resolveExport?: (specifier: string, name: string) => unknown;
}
let { cookbook, catalog, sectionId, oncookbookchange, resolveExport }: Props =
  $props();
</script>

{#snippet saver()}
  {@const ctx = getCookbookContext()}
  <button
    type="button"
    onclick={() =>
      ctx.setOverride(sectionId, {
        version: 1,
        added: [{ id: 'w1', type: 'note', span: 2, options: { body: 'Hi' } }],
      })}>save-override</button
  >
  <button type="button" onclick={() => ctx.setOverride(sectionId, null)}
    >reset-override</button
  >
{/snippet}

<CookbookApp
  {cookbook}
  {catalog}
  storageKey="cookbook-test"
  currentHref={`/s/${sectionId.replace(':', '-')}/`}
  {oncookbookchange}
  {resolveExport}
  layoutEditing
>
  <CookbookSectionPage {sectionId} />
  {@render saver()}
</CookbookApp>
