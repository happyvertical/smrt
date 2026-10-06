import type { Recipe } from './types.ts';

/**
 * One card on the Planner: a recipe, or a group of recipes (`group`) that
 * share a card with a sub-switch each. Local to the planner; the card list is
 * derived from the recipes, never declared.
 */
export interface PlannerCard {
  /** The group id, or the recipe id for a recipe with no group. */
  id: string;
  label: string;
  summary: string;
  /** In declaration order; the first is what turning the card on adds. */
  recipes: Recipe[];
  /** More than one recipe: the card shows a sub-switch for each. */
  hasSubSwitches: boolean;
}

/** Cards by label, each with its recipes in declaration order. */
export function buildCards(recipes: readonly Recipe[]): PlannerCard[] {
  const cards = new Map<string, PlannerCard>();
  for (const recipe of recipes) {
    const id = recipe.group?.id ?? recipe.id;
    const existing = cards.get(id);
    if (existing) {
      existing.recipes.push(recipe);
      existing.hasSubSwitches = true;
    } else {
      cards.set(id, {
        id,
        label: recipe.group?.label ?? recipe.label,
        summary: recipe.group?.summary ?? recipe.summary,
        recipes: [recipe],
        hasSubSwitches: false,
      });
    }
  }
  return [...cards.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The card's main switch is on while any of its recipes is. */
export function cardIsOn(
  card: PlannerCard,
  selected: readonly string[],
): boolean {
  return card.recipes.some((recipe) => selected.includes(recipe.id));
}

/**
 * The recipe ids after flipping the main switch: on adds the first
 * sub-recipe, off removes every one. (Recipes other recipes need stay on:
 * the caller's `remove`/`add` apply `requires`.)
 */
export function mainSwitchChange(
  card: PlannerCard,
  selected: readonly string[],
  on: boolean,
): { add: string[]; remove: string[] } {
  if (on) {
    const first = card.recipes[0];
    return {
      add: first && !cardIsOn(card, selected) ? [first.id] : [],
      remove: [],
    };
  }
  return { add: [], remove: card.recipes.map((r) => r.id) };
}

/** Turning a sub-switch on adds that recipe; off removes it. The main switch follows. */
export function subSwitchChange(
  recipeId: string,
  on: boolean,
): { add: string[]; remove: string[] } {
  return on ? { add: [recipeId], remove: [] } : { add: [], remove: [recipeId] };
}
