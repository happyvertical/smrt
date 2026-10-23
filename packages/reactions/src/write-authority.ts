import { ValidationError } from '@happyvertical/smrt-core';

/** Authority belongs only to a unique operation transaction, never a root adapter. */
const authority = new WeakMap<object, number>();
/** Package-private authority; never re-export from a public entry point. */
export async function withParticipationWrite<T>(
  executor: object,
  work: () => Promise<T>,
): Promise<T> {
  authority.set(executor, (authority.get(executor) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const remaining = (authority.get(executor) ?? 1) - 1;
    if (remaining) authority.set(executor, remaining);
    else authority.delete(executor);
  }
}
export function assertParticipationWrite(executor: object): void {
  if (!authority.has(executor))
    throw new ValidationError(
      'Participation records require service write authority.',
      'VALIDATION_PARTICIPATION_AUTHORITY',
    );
}
