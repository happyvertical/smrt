import { getContext, setContext } from 'svelte';
import type {
  ControlInteractionRegistry,
  ControlSubject,
} from './control-interaction.js';

const CONTROL_INTERACTION_KEY = Symbol('smrt-control-interaction');

export interface ControlInteractionContextValue {
  readonly formId: string;
  readonly registry: ControlInteractionRegistry;
}

export function setControlInteractionContext(
  context: ControlInteractionContextValue,
): void {
  setContext(CONTROL_INTERACTION_KEY, context);
}

export function tryGetControlInteractionContext():
  | ControlInteractionContextValue
  | undefined {
  return getContext<ControlInteractionContextValue | undefined>(
    CONTROL_INTERACTION_KEY,
  );
}

export function getControlInteractionContext(): ControlInteractionContextValue {
  const context = tryGetControlInteractionContext();
  if (!context) {
    throw new Error(
      'Control interaction context not found. Wrap controls in <Form>.',
    );
  }
  return context;
}

/**
 * Records an edit made by a composite control's own user-event handler.
 *
 * Native inputs bubble trusted `input`/`change` events to their Form host.
 * Composite controls must use this only after a user action has actually
 * changed their value; programmatic setters deliberately do not call it.
 */
export function recordControlUserEdit(
  context: ControlInteractionContextValue | undefined,
  controlId: string | undefined,
  subject: ControlSubject | undefined,
): void {
  if (!context || !controlId) return;
  context.registry.recordUserEdit?.({
    formId: context.formId,
    controlId,
    subject,
  });
}
