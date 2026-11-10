<script lang="ts">
/**
 * A navigation section's own page in a cookbook app (#3749). The sidebar lists
 * only sections, so this is where a section's entries are: an editable
 * overview (the entries as themed cards by default, unframed shortcuts
 * with explicit `presentation="plain"`) with the shell's layout
 * edit mode driving its grid. A section with no overview shows its menu.
 *
 * Render it from one route (`s/[slug]/+page.svelte`), inside `CookbookApp`.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.overview.js';
import type { OverviewOverride } from '../overview/types.js';
import { useShellLayout } from '../workspace/admin-shell/layout-context.js';
import ShellSectionIcon from '../workspace/admin-shell/ShellSectionIcon.svelte';
import ShellSectionMenu from '../workspace/admin-shell/ShellSectionMenu.svelte';
import CookbookSectionOverview from './CookbookSectionOverview.svelte';
import { getCookbookContext } from './context.js';
import { DEFAULT_SECTION_ICON, sectionIdFromSlug } from './sections.js';
import type { CookbookSectionPageProps } from './types.js';

let {
  sectionId,
  slug,
  children,
  presentation = 'card',
  heading,
}: CookbookSectionPageProps = $props();

const { t } = useI18n();
const cookbook = getCookbookContext();
const layout = useShellLayout();

const id = $derived(sectionId ?? (slug ? sectionIdFromSlug(slug) : ''));
const section = $derived(layout.sections.find((s) => s.id === id));
const suggested = $derived(cookbook.shell.sections.find((s) => s.id === id));
const title = $derived(section?.heading?.trim() || suggested?.label || '');
const icon = $derived(section?.icon ?? suggested?.icon ?? DEFAULT_SECTION_ICON);
const description = $derived(suggested?.description);
const page = $derived(cookbook.shell.overviews[id]);
const registry = $derived(cookbook.registry);
const headingInfo = $derived({
  id,
  title,
  icon,
  ...(description ? { description } : {}),
});
const store = {
  overview: (key: string) => cookbook.overrideFor(key),
  setOverview: (key: string, override: OverviewOverride | null) =>
    cookbook.setOverride(key, override),
};
</script>

<svelte:head>
  {#if title}<title>{title}</title>{/if}
</svelte:head>

<main class="smrt-cookbook-section-page__root" data-smrt-component="CookbookSectionPage">
  {#if section}
    {#if heading}
      {@render heading({ section: headingInfo })}
    {:else}
      <header data-smrt-part="header">
        <span class="smrt-cookbook-section-page__mark" data-smrt-part="icon"><ShellSectionIcon name={icon} size={28} /></span>
        <div class="smrt-cookbook-section-page__heading" data-smrt-part="content">
          <h1 data-smrt-part="title">{title}</h1>
          {#if description}<p>{description}</p>{/if}
        </div>
      </header>
    {/if}
    {#if page && registry}
      {#key id}
        <CookbookSectionOverview
          definition={page.definition}
          {registry}
          {store}
          entries={cookbook.shell.entries}
          components={cookbook.components}
          models={cookbook.models}
          hostContext={cookbook.widgetContext}
          label={`${title} overview`}
          {presentation}
        />
      {/key}
      {#if layout.editing}
        <section class="smrt-cookbook-section-page__entries" aria-labelledby="cookbook-section-entries" data-smrt-part="list">
          <h2 id="cookbook-section-entries" data-smrt-part="title">{t(M['ui.cookbook.menu_entries'])}</h2>
          <ShellSectionMenu sectionId={id} />
        </section>
      {/if}
    {:else if !page}
      <ShellSectionMenu sectionId={id} layout="cards" />
    {/if}
    {@render children?.()}
  {:else}
    <h1 data-smrt-part="title">{t(M['ui.cookbook.section_not_found'])}</h1>
    <p data-smrt-part="hint">{t(M['ui.cookbook.section_not_found_hint'])}</p>
  {/if}
</main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-cookbook-section-page__root {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 64rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
  }
  .smrt-cookbook-section-page__mark {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 3rem;
    block-size: 3rem;
  }
  .smrt-cookbook-section-page__heading {
    flex: 1 1 auto;
    min-inline-size: 0;
  }
  h1 {
    margin: 0;
  }
  .smrt-cookbook-section-page__heading p {
    margin: var(--smrt-spacing-1) 0 0;
  }
  .smrt-cookbook-section-page__entries {
    display: grid;
    gap: var(--smrt-spacing-3);
  }
  .smrt-cookbook-section-page__entries h2 {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-cookbook-section-page__mark {
    border-radius: var(--smrt-radius-large, 0.75rem);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-cookbook-section-page__heading p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-cookbook-section-page__entries h2 {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
}

</style>
