<script lang="ts">
import type { Cookbook } from '@happyvertical/smrt-types';
import CookbookApp from '../CookbookApp.svelte';
import CookbookSectionPage from '../CookbookSectionPage.svelte';
import { getCookbookContext } from '../context.js';
import type { CookbookCatalog, CookbookLoaders } from '../types.js';

interface Props {
  cookbook: Cookbook;
  catalog: CookbookCatalog;
  sectionId: string;
  oncookbookchange?: (cookbook: Cookbook) => void;
  resolveExport?: (specifier: string, name: string) => unknown;
  presentation?: 'plain' | 'card';
  customHeading?: boolean;
  loaders?: CookbookLoaders;
}
let {
  cookbook,
  catalog,
  sectionId,
  oncookbookchange,
  resolveExport,
  presentation,
  customHeading = false,
  loaders,
}: Props = $props();
</script>

{#snippet customTitle({ section }: { section: { id: string; title: string } })}
  <h1 data-testid="custom-heading">Custom {section.title}</h1>
{/snippet}

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
  {loaders}
  layoutEditing
>
  <CookbookSectionPage
    {sectionId}
    {presentation}
    heading={customHeading ? customTitle : undefined}
  />
  {@render saver()}
</CookbookApp>
