// What the signed-in person may do with a model, for hiding controls (#5197).
// The record routes decide; this only keeps staff from seeing buttons that
// would be refused. The owner (no `staff` marker) may do everything, and a
// staff description with no entry for the model is closed.
import type { Description } from './types.ts';

export type RecordAction = 'create' | 'update' | 'delete';

export function can(
  description: Pick<Description, 'staff' | 'access'>,
  model: string,
  action: RecordAction,
): boolean {
  if (!description.staff) return true;
  // Staff never delete: it waits for the owner.
  if (action === 'delete') return false;
  return description.access?.[model]?.[action] === true;
}
