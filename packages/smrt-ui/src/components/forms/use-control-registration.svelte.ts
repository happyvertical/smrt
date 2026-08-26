import { onDestroy, untrack } from 'svelte';
import type {
  ControlRegistration,
  ControlSubject,
} from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';

export interface ControlRegistrationDescriptor
  extends Omit<ControlRegistration, 'identity'> {
  controlId: string | undefined;
  subject?: ControlSubject;
}

/** Register a reactive control descriptor with the nearest Form registry. */
export function useControlRegistration(
  getDescriptor: () => ControlRegistrationDescriptor | false,
): void {
  const context = tryGetControlInteractionContext();
  let disposeCurrent: (() => void) | undefined;

  onDestroy(() => {
    disposeCurrent?.();
    disposeCurrent = undefined;
  });

  $effect(() => {
    const descriptor = getDescriptor();
    if (!context || descriptor === false || !descriptor.controlId) {
      disposeCurrent?.();
      disposeCurrent = undefined;
      return;
    }
    const { controlId, subject, ...registration } = descriptor;
    const previousDispose = disposeCurrent;
    disposeCurrent = untrack(() =>
      context.registry.register({
        ...registration,
        identity: { formId: context.formId, controlId, subject },
      }),
    );
    // Register the replacement before disposing the prior descriptor. For a
    // same-identity reactive update the old disposer then becomes a no-op,
    // preserving staged proposals, undo history, and user-edit snapshots.
    previousDispose?.();
  });
}
