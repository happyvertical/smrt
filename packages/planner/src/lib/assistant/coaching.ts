import type { CommandResult, PlanSnapshot } from '../planner/commands/types.ts';
import type { Recipe } from '../recipes/types.ts';

/** Trusted guidance derived only after execution, never from proposed model prose. */
export function appliedCoaching(
  before: PlanSnapshot,
  after: PlanSnapshot,
  results: readonly CommandResult[],
  _recipes: readonly Recipe[],
): string {
  if (!results.length || results.some((result) => !result.ok)) return '';
  if (!results.some((result) => result.ok && result.receipt.changed)) return '';
  const visible = after.sections.filter((section) => !section.hidden);
  const section = visible.find((candidate) =>
    candidate.items.some((item) => !item.hidden),
  );
  const item = section?.items.find((candidate) => !candidate.hidden);
  const initial = before.recipes.length === 0 && after.recipes.length > 0;
  const guidance =
    initial && section && item
      ? `This is an interactive demo with fictional sample records. Open ${section.label} → ${item.label}, select a record to edit it, or use New to add your own.`
      : '';
  // Successful setup hands the agenda back to the person. Related catalog
  // entries are capabilities, not an ordered list of unsolicited next steps.
  const question =
    initial && item ? 'What else would you like your app to do?' : '';
  return [guidance, question].filter(Boolean).join(' ');
}

/** Short literal speech, derived from applied state rather than model prose. */
export function appliedSpokenCoaching(
  before: PlanSnapshot,
  after: PlanSnapshot,
  results: readonly CommandResult[],
): string {
  if (!results.length || results.some((result) => !result.ok)) return '';
  if (!results.some((result) => result.ok && result.receipt.changed)) return '';
  const visible = after.sections.filter((section) => !section.hidden);
  const initial = before.recipes.length === 0 && after.recipes.length > 0;
  if (
    initial &&
    visible.some((section) => section.items.some((item) => !item.hidden))
  )
    return 'Your demo app is ready with fictional records. Open its main menu to explore or edit a record. Edit arranges the menu and page layout. What else would you like your app to do?';
  const previous = new Set(
    before.sections.flatMap((section) => section.items.map((item) => item.id)),
  );
  const added = visible.flatMap((section) =>
    section.items
      .filter((item) => !item.hidden && !previous.has(item.id))
      .map((item) => ({ section, item })),
  );
  if (added.length) {
    const section = added[0].section.label;
    const location =
      section.length <= 40 && section.split(/\s+/).length <= 6
        ? `${section} in the planner’s main menu`
        : 'the planner’s main menu';
    return `Added ${added.length} menu ${added.length === 1 ? 'item' : 'items'}. Find ${added.length === 1 ? 'it' : 'them'} under ${location}.`;
  }
  return 'Your changes are applied in the planner.';
}
