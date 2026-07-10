import { getContext, setContext } from 'svelte';
import type { ControlInteractionRegistry } from './control-interaction.js';

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
