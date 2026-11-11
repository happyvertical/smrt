<script lang="ts">
import type { Cookbook } from '@happyvertical/smrt-types';
import ImportExport from '../../import-export/ImportExport.svelte';
import type { ImportExportProps } from '../../import-export/props.js';
import DetailScreen from '../../screens/DetailScreen.svelte';
import EditForm from '../../screens/EditForm.svelte';
import ListScreen from '../../screens/ListScreen.svelte';
import RecipeScreens from '../../screens/RecipeScreens.svelte';
import RecordScreen from '../../screens/RecordScreen.svelte';
import type {
  RecipeScreensProps,
  ScreenPolicy,
  ScreenRecord,
} from '../../screens/types.js';
import CookbookApp from '../CookbookApp.svelte';
import CookbookSectionPage from '../CookbookSectionPage.svelte';
import { getCookbookContext } from '../context.js';
import type {
  CookbookAppProps,
  CookbookCatalog,
  CookbookLoaders,
} from '../types.js';

interface Props {
  cookbook: Cookbook;
  fieldPolicies?: Record<string, ScreenPolicy>;
  screenProps?: RecipeScreensProps;
  standalone?: 'list' | 'detail' | 'record' | 'form';
  standaloneRecord?: ScreenRecord;
  exportProps?: ImportExportProps;
  catalog: CookbookCatalog;
  sectionId: string;
  oncookbookchange?: (cookbook: Cookbook) => void;
  resolveExport?: (specifier: string, name: string) => unknown;
  presentation?: 'plain' | 'card';
  customHeading?: boolean;
  loaders?: CookbookLoaders;
  assistant?: CookbookAppProps['assistant'];
  embed?: boolean;
}
let {
  cookbook,
  fieldPolicies,
  screenProps,
  standalone,
  standaloneRecord,
  exportProps,
  catalog,
  sectionId,
  oncookbookchange,
  resolveExport,
  presentation,
  customHeading = false,
  loaders,
  assistant,
  embed,
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
  {fieldPolicies}
  storageKey="cookbook-test"
  currentHref={`/s/${sectionId.replace(':', '-')}/`}
  {oncookbookchange}
  {resolveExport}
  {loaders}
  {assistant}
  {embed}
  phoneTabBar
  layoutEditing
>
  {#if exportProps}<ImportExport {...exportProps} />{/if}
  {#if standalone && screenProps}
    {#if standalone === 'list'}
      <ListScreen definition={screenProps.definition} rows={standaloneRecord ? [standaloneRecord] : []} />
    {:else if standalone === 'detail' && standaloneRecord}
      <DetailScreen definition={screenProps.definition} record={standaloneRecord} />
    {:else if standalone === 'record' && standaloneRecord}
      <RecordScreen definition={screenProps.definition} record={standaloneRecord} mode="view" />
    {:else if standalone === 'form'}
      <EditForm definition={screenProps.definition} record={standaloneRecord}
        onsubmit={async values => {
          if (standaloneRecord) await screenProps.source.update?.(String(standaloneRecord.id), values);
          else await screenProps.source.create?.(values);
        }} />
    {/if}
  {:else if screenProps}
    <RecipeScreens {...screenProps} />
  {:else}
  <CookbookSectionPage
    {sectionId}
    {presentation}
    heading={customHeading ? customTitle : undefined}
  />
  {/if}
  {@render saver()}
</CookbookApp>
