import { removalBlockers } from './resolve.ts';
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

/** What keeps a card's switches on: the selected recipes that need them. */
export interface CardLocks {
  /** Recipes that keep the card on at all (main switch locked when non-empty). */
  main: string[];
  /**
   * Recipes that keep one sub-recipe on, by sub-recipe id. Only sub-recipes
   * that are themselves locked have an entry: the others change freely.
   */
  subs: Record<string, string[]>;
}

/**
 * Which switches on a card are locked. The main switch locks while something
 * needs any of the card's recipes; a sub-switch locks only when removing that
 * one recipe would force it back on (it is the last alternative), so the
 * others stay fully usable.
 */
export function cardLocks(
  card: PlannerCard,
  selected: readonly string[],
  recipes: ReadonlyMap<string, Recipe>,
): CardLocks {
  const on = card.recipes.filter((r) => selected.includes(r.id));
  const subs: Record<string, string[]> = {};
  if (card.hasSubSwitches) {
    for (const recipe of on) {
      const blockers = removalBlockers([recipe.id], selected, recipes);
      if (blockers.length) subs[recipe.id] = blockers;
    }
  }
  return {
    main: on.length
      ? removalBlockers(
          card.recipes.map((r) => r.id),
          selected,
          recipes,
        )
      : [],
    subs,
  };
}

/** The note under a locked main switch, in words. */
export function mainLockNote(card: PlannerCard, needers: string[]): string {
  const by = needers.join(', ');
  return card.hasSubSwitches
    ? `${card.label} stays on while ${by} needs at least one ${card.label} recipe.`
    : `${card.label} stays on while ${by} needs it.`;
}

/** The note under a locked sub-switch: it is the last one the needers can use. */
export function subLockNote(
  card: PlannerCard,
  recipeLabel: string,
  needers: string[],
): string {
  return `${recipeLabel} is the last ${card.label} recipe on, and ${needers.join(', ')} needs one.`;
}
