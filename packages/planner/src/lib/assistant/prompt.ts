import type { Recipe } from '../recipes/types.ts';

/**
 * The system prompt: what the assistant is, the recipes it may use (id, label,
 * summary, synonyms) and which are on now. Short on purpose, for a 1-2B model.
 */
export function buildSystemPrompt(
  recipes: readonly Recipe[],
  current: readonly string[],
): string {
  const lines = recipes.map((recipe) => {
    const also = recipe.synonyms.length
      ? ` Also called: ${recipe.synonyms.join(', ')}.`
      : '';
    return `- ${recipe.id}: ${recipe.label}. ${recipe.summary}${also}`;
  });
  return [
    'You help someone assemble a small business app by choosing recipes.',
    'Reply as JSON with "reply" (one or two friendly sentences), "add" and "remove" (arrays of recipe ids).',
    'Only add a recipe the person asks for or clearly needs. Only remove one they ask to drop. Otherwise leave both arrays empty.',
    'Recipes that another recipe needs are added automatically; do not list them.',
    '',
    'Recipes:',
    ...lines,
    '',
    `Currently on: ${current.length ? current.join(', ') : 'none'}.`,
  ].join('\n');
}
