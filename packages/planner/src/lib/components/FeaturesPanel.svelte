<script lang="ts">
import { Disclosure } from '@happyvertical/smrt-ui';
import { SearchInput, ToggleButton } from '@happyvertical/smrt-ui/forms';
import { catalog } from '../catalog/index.ts';
import {
  alsoAdds,
  buildFeatureCards,
  cardsByGroup,
  featureGroups,
  filterFeatureCards,
} from '../features/catalogue.ts';
import { recipes, recipesById } from '../recipes/index.ts';
import { removalBlockers } from '../recipes/resolve.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import FeatureCard from './FeatureCard.svelte';
import RecordFeatures from './RecordFeatures.svelte';

const all = buildFeatureCards(recipes, catalog.packages);
const groups = featureGroups(all);

let query = $state('');
let groupId = $state<string | null>(null);
let notice = $state('');

const results = $derived(filterFeatureCards(all, query, groupId));
const sections = $derived(cardsByGroup(results));

const label = (id: string) => recipesById.get(id)?.label ?? id;

// Switching never navigates: the feature joins the cookbook whenever the
// visitor likes, with what it requires, and the status line says what changed.
function toggle(id: string, on: boolean) {
  const before = new Set(recipeState.ids);
  if (on) recipeState.add(id);
  else recipeState.remove(id);
  const after = new Set(recipeState.ids);
  const added = recipeState.ids.filter((other) => !before.has(other));
  const removed = [...before].filter((other) => !after.has(other));
  const parts: string[] = [];
  if (added.length) parts.push(`Added ${added.map(label).join(', ')}.`);
  if (removed.length) parts.push(`Removed ${removed.map(label).join(', ')}.`);
  notice = parts.join(' ');
}
</script>

<div class="smrt-features-panel__root" data-smrt-component="FeaturesPanel">
  <p class="smrt-features-panel__meta" data-smrt-part="meta">
    Everything s-m-r-t can add to your app. Switch a feature on to add it, with
    what it needs, to your cookbook. Each label says how far it runs in this
    browser-only demo; menu entries appear in the sidebar, while widgets, pages
    and panels are listed for the real app and are not mounted here.
  </p>

  <SearchInput
    value={query}
    onsearch={(next) => {
      query = next;
    }}
    label="Search features"
    placeholder="Search features"
    debounceMs={0}
  />

  {#if groups.length > 1}
    <div class="smrt-features-panel__chips" data-smrt-part="chips" role="group" aria-label="Browse by group">
      <ToggleButton pressed={groupId === null} onclick={() => (groupId = null)}>
        All
      </ToggleButton>
      {#each groups as group (group.id)}
        <ToggleButton
          pressed={groupId === group.id}
          onclick={() => (groupId = groupId === group.id ? null : group.id)}
        >
          {group.label}
        </ToggleButton>
      {/each}
    </div>
  {/if}

  <p class="smrt-features-panel__count" data-smrt-part="count" aria-live="polite">
    {results.length} {results.length === 1 ? 'feature' : 'features'}
  </p>

  {#each sections as section (section.group.id)}
    <section aria-labelledby={`group-${section.group.id}`}>
      <h2 id={`group-${section.group.id}`}>{section.group.label}</h2>
      {#if section.group.summary}
        <p class="smrt-features-panel__meta" data-smrt-part="meta">{section.group.summary}</p>
      {/if}
      <ul class="smrt-features-panel__cards" data-smrt-part="list" aria-label={`${section.group.label} features`}>
        {#each section.cards as card (card.id)}
          <FeatureCard
            {card}
            on={recipeState.has(card.id)}
            lockedBy={removalBlockers([card.id], recipeState.ids, recipesById).map(label)}
            alsoAdds={alsoAdds(card.id, recipeState.ids, recipesById).map(label)}
            onchange={(on) => toggle(card.id, on)}
          />
        {/each}
      </ul>
    </section>
  {:else}
    <p class="smrt-features-panel__meta" data-smrt-part="meta">No features match "{query}".</p>
  {/each}
  <p class="smrt-features-panel__notice smrt-features-panel__meta" data-smrt-part="notice" role="status" aria-live="polite">{notice}</p>

  <Disclosure title="Single records">
    <RecordFeatures />
  </Disclosure>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-features-panel__root {
    display: grid;
    gap: var(--smrt-spacing-3);
  }
  h2,
  p {
    margin: 0;
  }
  section {
    display: grid;
    gap: var(--smrt-spacing-2);
  }
  .smrt-features-panel__notice:empty {
    display: none;
  }
  .smrt-features-panel__chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }
  .smrt-features-panel__cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
}

@layer smrt.theme {
  .smrt-features-panel__meta,
  .smrt-features-panel__count {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-features-panel__count {
    font-size: var(--smrt-typography-body-medium-size);
  }
}

</style>
