<script lang="ts">
import { Fieldset, Switch } from '@happyvertical/smrt-ui/forms';
import {
  buildCards,
  cardIsOn,
  cardLocks,
  mainLockNote,
  mainSwitchChange,
  type PlannerCard,
  subLockNote,
  subSwitchChange,
} from '../recipes/cards.ts';
import { recipes, recipesById } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';

const cards = buildCards(recipes);

let notice = $state('');

const label = (id: string) => recipesById.get(id)?.label ?? id;
const names = (ids: readonly string[]) => ids.map(label).join(', ');

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

  <ul class="smrt-recipe-cards__root" aria-label="Recipes" data-smrt-component="RecipeCards">
    {#each cards as card (card.id)}
      {@const on = mainOn(card)}
      {@const locks = cardLocks(card, recipeState.ids, recipesById)}
      {@const needed = locks.main}
      <li class:smrt-recipe-cards__selected={on} data-smrt-part="item">
        <h2 id={`card-${card.id}`}>{card.label}</h2>
        <p class="smrt-recipe-cards__description" id={`card-${card.id}-summary`} data-smrt-part="description">{card.summary}</p>
        <Switch
          label={card.label}
          checked={on}
          disabled={needed.length > 0}
          aria-describedby={`card-${card.id}-summary${needed.length ? ` card-${card.id}-needed` : ''}`}
          onchange={(event) =>
            apply(mainSwitchChange(card, recipeState.ids, event.currentTarget.checked))}
        />
        {#if needed.length}
          <p class="smrt-recipe-cards__meta" id={`card-${card.id}-needed`} data-smrt-part="meta">{mainLockNote(card, needed.map(label))}</p>
        {/if}
        {#if card.hasSubSwitches}
          <Fieldset legend={`${card.label} recipes`} stack class="subs">
            {#each card.recipes as recipe (recipe.id)}
              {@const subOn = recipeState.has(recipe.id)}
              {@const subNeeded = locks.subs[recipe.id] ?? []}
              <div class="smrt-recipe-cards__sub" data-smrt-part="row">
                <Switch
                  label={recipe.label}
                  size="sm"
                  checked={subOn}
                  disabled={subNeeded.length > 0}
                  aria-describedby={`sub-${recipe.id}-summary${subNeeded.length ? ` sub-${recipe.id}-needed` : ''}`}
                  onchange={(event) =>
                    apply(subSwitchChange(recipe.id, event.currentTarget.checked))}
                />
                <p class="smrt-recipe-cards__meta" id={`sub-${recipe.id}-summary`} data-smrt-part="meta">{recipe.summary}</p>
                {#if subNeeded.length}
                  <p class="smrt-recipe-cards__meta" id={`sub-${recipe.id}-needed`} data-smrt-part="meta">
                    {subLockNote(card, recipe.label, subNeeded.map(label))}
                  </p>
                {/if}
              </div>
            {/each}
          </Fieldset>
        {/if}
        {#if !on && needsOf(card)}
          <p class="smrt-recipe-cards__meta" data-smrt-part="meta">Needs {needsOf(card)}.</p>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="smrt-recipe-cards__notice" role="status" aria-live="polite" data-smrt-component="RecipeCards">{notice}</p>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  h2,
  p {
    margin: 0;
  }
  .smrt-recipe-cards__notice:empty {
    display: none;
  }
  .smrt-recipe-cards__root {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-recipe-cards__root li {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
  }
  .smrt-recipe-cards__sub {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
}

@layer smrt.theme {
  .smrt-recipe-cards__meta,
  .smrt-recipe-cards__description,
  .smrt-recipe-cards__notice {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-recipe-cards__root li {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
  }
  .smrt-recipe-cards__root li.smrt-recipe-cards__selected {
    border-color: var(--smrt-color-primary);
  }
  /* Forced colours: a switched-on recipe's border colour is replaced, so it
  gets a Highlight frame. */
  @media (forced-colors: active) {
    .smrt-recipe-cards__root li.smrt-recipe-cards__selected {
      border-color: Highlight;
      outline: 0.125rem solid Highlight;
    }
  }
}

</style>
