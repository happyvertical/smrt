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
  $effect(() => {
    const descriptor = getDescriptor();
    if (!context || descriptor === false || !descriptor.controlId) return;
    const { controlId, subject, ...registration } = descriptor;
    return context.registry.register({
      ...registration,
      identity: { formId: context.formId, controlId, subject },
    });
  });
}
