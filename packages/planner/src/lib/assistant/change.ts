import type { Recipe } from '../recipes/types.ts';

/** What the model returns each turn: a reply and recipe ids to add or remove. */
export interface AssistantChange {
  reply: string;
  add: string[];
  remove: string[];
}

/** The slice of the recipe store the assistant drives (the Planner cards use the same). */
export interface RecipeStore {
  readonly ids: readonly string[];
  add(...ids: string[]): void;
  remove(...ids: string[]): void;
}

/** The result of applying a change, after `requires` and `requiresAny` ran. */
export interface AppliedChange {
  /** Newly on, including recipes pulled in because another needs them. */
  added: string[];
  /** Newly off. */
  removed: string[];
  /** Asked to remove, but another added recipe needs them. */
  kept: string[];
}

/**
 * The JSON Schema for one turn. `add` and `remove` are enums of recipe ids,
 * so grammar-constrained decoding cannot produce an id that does not exist.
 */
export function buildResponseSchema(
  recipes: readonly Pick<Recipe, 'id'>[],
): Record<string, unknown> {
  const ids = recipes.map((recipe) => recipe.id);
  const list = { type: 'array', items: { enum: ids }, maxItems: ids.length };
  return {
    type: 'object',
    properties: { reply: { type: 'string' }, add: list, remove: list },
    required: ['reply', 'add', 'remove'],
    additionalProperties: false,
  };
}

/**
 * Read a model reply. Anything that is not the expected shape degrades to a
 * plain reply with no changes; unknown ids are dropped, an id that is both
 * added and removed is ignored, and repeats collapse.
 */
export function parseChange(
  raw: string,
  recipes: readonly Pick<Recipe, 'id'>[],
): AssistantChange {
  const known = new Set(recipes.map((recipe) => recipe.id));
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reply: raw.trim(), add: [], remove: [] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { reply: raw.trim(), add: [], remove: [] };
  }
  const object = value as Record<string, unknown>;
  const pick = (field: unknown): string[] =>
    Array.isArray(field)
      ? [
          ...new Set(
            field.filter(
              (id): id is string => typeof id === 'string' && known.has(id),
            ),
          ),
        ]
      : [];
  const add = pick(object.add);
  const remove = pick(object.remove);
  const both = new Set(add.filter((id) => remove.includes(id)));
  return {
    reply: typeof object.reply === 'string' ? object.reply.trim() : '',
    add: add.filter((id) => !both.has(id)),
    remove: remove.filter((id) => !both.has(id)),
  };
}

/** Apply a change through the store and report what really changed. */
export function applyChange(
  store: RecipeStore,
  change: Pick<AssistantChange, 'add' | 'remove'>,
): AppliedChange {
  const before = new Set(store.ids);
  if (change.add.length) store.add(...change.add);
  if (change.remove.length) store.remove(...change.remove);
  const after = new Set(store.ids);
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
    kept: change.remove.filter((id) => after.has(id) && before.has(id)),
  };
}

/** A sentence for the chat saying what changed, by recipe label. */
export function describeChange(
  applied: AppliedChange,
  recipes: readonly Pick<Recipe, 'id' | 'label'>[],
): string {
  const label = (id: string) =>
    recipes.find((recipe) => recipe.id === id)?.label ?? id;
  const names = (ids: string[]) => ids.map(label).join(', ');
  const parts: string[] = [];
  if (applied.added.length) parts.push(`Added ${names(applied.added)}.`);
  if (applied.removed.length) parts.push(`Removed ${names(applied.removed)}.`);
  if (applied.kept.length) {
    parts.push(`Kept ${names(applied.kept)}, which another recipe needs.`);
  }
  return parts.join(' ');
}
