/**
 * The models a section overview's option editor offers: the app's, i.e. the
 * added recipes' models and the features' entries, each once, labelled as the
 * menu would. The standalone section page and the mounted `Planner`'s section
 * view compute the same list from the same inputs.
 */
import type { OverviewModelChoice } from '@happyvertical/smrt-svelte/overview';
import { humanize, pluralize } from '../data/format.ts';
import { recipeModels } from '../recipes/index.ts';
import type { Recipe } from '../recipes/types.ts';
import type { SectionEntry } from '../sections/entries.ts';

export function overviewModelChoices(
  added: readonly Recipe[],
  index: ReadonlyMap<string, SectionEntry>,
): OverviewModelChoice[] {
  const ids = new Set<string>();
  const choices: OverviewModelChoice[] = [];
  const offer = (id: string, name: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    choices.push({ value: id, label: pluralize(humanize(name)) });
  };
  for (const recipe of added) {
    for (const { model } of recipeModels(recipe)) offer(model.id, model.name);
  }
  for (const entry of index.values()) offer(entry.model.id, entry.model.name);
  return choices;
}
