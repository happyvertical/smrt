<script lang="ts">
/**
 * A navigation section's own page in a cookbook app (#3749). The sidebar lists
 * only sections, so this is where a section's entries are: an editable
 * overview (the entries as shortcut cards by default) with the shell's layout
 * edit mode driving its grid. A section with no overview shows its menu.
 *
 * Render it from one route (`s/[slug]/+page.svelte`), inside `CookbookApp`.
 */
import type { OverviewOverride } from '../overview/types.js';
import { useShellLayout } from '../workspace/admin-shell/layout-context.js';
import ShellSectionIcon from '../workspace/admin-shell/ShellSectionIcon.svelte';
import ShellSectionMenu from '../workspace/admin-shell/ShellSectionMenu.svelte';
import CookbookSectionOverview from './CookbookSectionOverview.svelte';
import { getCookbookContext } from './context.js';
import { DEFAULT_SECTION_ICON, sectionIdFromSlug } from './sections.js';
import type { CookbookSectionPageProps } from './types.js';

let { sectionId, slug, children }: CookbookSectionPageProps = $props();

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
const store = {
  overview: (key: string) => cookbook.overrideFor(key),
  setOverview: (key: string, override: OverviewOverride | null) =>
    cookbook.setOverride(key, override),
};
</script>

<svelte:head>
  {#if title}<title>{title}</title>{/if}
</svelte:head>

<main class="cookbook-section">
  {#if section}
    <header>
      <span class="mark"><ShellSectionIcon name={icon} size={28} /></span>
      <div class="heading">
        <h1>{title}</h1>
        {#if description}<p>{description}</p>{/if}
      </div>
    </header>
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
        />
      {/key}
      {#if layout.editing}
        <section class="entries" aria-labelledby="cookbook-section-entries">
          <h2 id="cookbook-section-entries">Menu entries</h2>
          <ShellSectionMenu sectionId={id} />
        </section>
      {/if}
    {:else if !page}
      <ShellSectionMenu sectionId={id} layout="cards" />
    {/if}
    {@render children?.()}
  {:else}
    <h1>Section not found</h1>
    <p>This section is not in your app.</p>
  {/if}
</main>

<style>
  .cookbook-section {
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

  .mark {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 3rem;
    block-size: 3rem;
    border-radius: var(--smrt-radius-large, 0.75rem);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .heading {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  h1 {
    margin: 0;
  }

  .heading p {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .entries {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .entries h2 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
</style>
