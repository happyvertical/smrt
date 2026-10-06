<script lang="ts">
import { Fieldset, Switch } from '@happyvertical/smrt-ui/forms';
import {
  buildCards,
  cardIsOn,
  mainSwitchChange,
  type PlannerCard,
  subSwitchChange,
} from '$lib/recipes/cards.ts';
import { recipes, recipesById } from '$lib/recipes/index.ts';
import { removalBlockers } from '$lib/recipes/resolve.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';

const cards = buildCards(recipes);

let notice = $state('');

const label = (id: string) => recipesById.get(id)?.label ?? id;
const names = (ids: readonly string[]) => ids.map(label).join(', ');

/** Dependents that keep these recipes on, as their labels. */
const blockers = (ids: readonly string[]) =>
  removalBlockers(ids, recipeState.ids, recipesById);

// Switching never navigates: the recipe appears in the menu to explore
// whenever the visitor likes, and the status line announces what changed.
function apply(change: { add: string[]; remove: string[] }) {
  const before = new Set(recipeState.ids);
  if (change.add.length) recipeState.add(...change.add);
  if (change.remove.length) recipeState.remove(...change.remove);
  const after = new Set(recipeState.ids);
  const added = recipeState.ids.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  const parts: string[] = [];
  if (added.length) parts.push(`Added ${names(added)} to the menu.`);
  if (removed.length) parts.push(`Removed ${names(removed)} from the menu.`);
  notice = parts.join(' ');
}

/** What a one-recipe card pulls in, in words; empty when nothing. */
function needsOf(card: PlannerCard): string {
  const recipe = card.recipes[0];
  if (!recipe || card.hasSubSwitches) return '';
  return [
    ...recipe.requires.map(label),
    ...(recipe.requiresAny ?? []).map((alts) => `one of ${names(alts)}`),
  ].join(', ');
}

const mainOn = (card: PlannerCard) => cardIsOn(card, recipeState.ids);
</script>

<svelte:head>
  <title>Planner · smrt planner</title>
</svelte:head>

<main>
  <ul class="cards" aria-label="Recipes">
    {#each cards as card (card.id)}
      {@const on = mainOn(card)}
      {@const needed = on ? blockers(card.recipes.map((r) => r.id)) : []}
      <li class:selected={on}>
        <h2 id={`card-${card.id}`}>{card.label}</h2>
        <p class="description" id={`card-${card.id}-summary`}>{card.summary}</p>
        <Switch
          label={card.label}
          checked={on}
          disabled={needed.length > 0}
          aria-describedby={`card-${card.id}-summary${needed.length ? ` card-${card.id}-needed` : ''}`}
          onchange={(event) =>
            apply(mainSwitchChange(card, recipeState.ids, event.currentTarget.checked))}
        />
        {#if needed.length}
          <p class="meta" id={`card-${card.id}-needed`}>Needed by {names(needed)}.</p>
        {/if}
        {#if card.hasSubSwitches}
          <Fieldset legend={`${card.label} recipes`} stack class="subs">
            {#each card.recipes as recipe (recipe.id)}
              {@const subOn = recipeState.has(recipe.id)}
              {@const subNeeded = subOn ? blockers([recipe.id]) : []}
              <div class="sub">
                <Switch
                  label={recipe.label}
                  size="sm"
                  checked={subOn}
                  disabled={subNeeded.length > 0}
                  aria-describedby={`sub-${recipe.id}-summary${subNeeded.length ? ` sub-${recipe.id}-needed` : ''}`}
                  onchange={(event) =>
                    apply(subSwitchChange(recipe.id, event.currentTarget.checked))}
                />
                <p class="meta" id={`sub-${recipe.id}-summary`}>{recipe.summary}</p>
                {#if subNeeded.length}
                  <p class="meta" id={`sub-${recipe.id}-needed`}>
                    Needed by {names(subNeeded)}.
                  </p>
                {/if}
              </div>
            {/each}
          </Fieldset>
        {/if}
        {#if !on && needsOf(card)}
          <p class="meta">Needs {needsOf(card)}.</p>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="notice" role="status" aria-live="polite">{notice}</p>
</main>

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-4);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  h2,
  p {
    margin: 0;
  }

  .meta,
  .description,
  .notice {
    color: var(--smrt-color-on-surface-variant);
  }

  .notice:empty {
    display: none;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cards li {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  .cards li.selected {
    border-color: var(--smrt-color-primary);
  }

  .sub {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
</style>
