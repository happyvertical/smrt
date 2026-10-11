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

<div class="features">
  <p class="meta">
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
    <div class="chips" role="group" aria-label="Browse by group">
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

  <p class="count" aria-live="polite">
    {results.length} {results.length === 1 ? 'feature' : 'features'}
  </p>

  {#each sections as section (section.group.id)}
    <section aria-labelledby={`group-${section.group.id}`}>
      <h2 id={`group-${section.group.id}`}>{section.group.label}</h2>
      {#if section.group.summary}
        <p class="meta">{section.group.summary}</p>
      {/if}
      <ul class="cards" aria-label={`${section.group.label} features`}>
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
    <p class="meta">No features match "{query}".</p>
  {/each}
  <p class="notice meta" role="status" aria-live="polite">{notice}</p>

  <Disclosure title="Single records">
    <RecordFeatures />
  </Disclosure>
</div>

<style>
  .features {
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

  .meta,
  .count {
    color: var(--smrt-color-on-surface-variant);
  }

  .count {
    font-size: var(--smrt-font-size-body-medium, 0.875rem);
  }

  .notice:empty {
    display: none;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
