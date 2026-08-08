/**
 * Svelte context for the field-policy form primitives (#2048).
 *
 * `FieldPolicyProvider` seeds a {@link FieldPolicyContextValue} into the
 * component tree from a pre-resolved {@link ResolvedObjectFieldPolicy} (SSR
 * `initialData` or a client fetch by the app — no smrt-web import in the
 * primitives). `PolicyField` and the mode-UX compositions read it through
 * {@link getFieldPolicyContext} / {@link tryGetFieldPolicyContext}.
 *
 * Mirrors the established `tryGet…` pattern (`tryGetControlInteractionContext`,
 * `useI18n`'s process-wide fallback) so `PolicyField` degrades gracefully
 * outside a Provider: an unwrapped field renders its children verbatim, and a
 * consumer can adopt the primitives incrementally without wrapping the whole
 * form.
 */

import { getContext, setContext } from 'svelte';
import type {
  ResolvedFieldPolicy,
  ResolvedObjectFieldPolicy,
} from '../types.js';

/** UI display mode for progressive disclosure. */
export type FieldPolicyMode = 'basic' | 'advanced';

/**
 * Reactive mode store implemented as a class with `$state` fields. Svelte 5
 * tracks `$state` on class instances correctly across context boundaries —
 * the instance is the reactive root, not the closure.
 */
export class FieldPolicyModeStore {
  current = $state<FieldPolicyMode>('basic');

  constructor(initial: FieldPolicyMode = 'basic') {
    this.current = initial;
  }

  set(next: FieldPolicyMode): void {
    this.current = next;
  }

  toggle(): void {
    this.current = this.current === 'basic' ? 'advanced' : 'basic';
  }
}

/** Svelte 5 runes-backed reactive context published by FieldPolicyProvider. */
export interface FieldPolicyContextValue {
  /** The fully resolved policy for one object. */
  readonly policy: ResolvedObjectFieldPolicy;
  /** Reactive mode store (basic/advanced) owned by the provider. */
  readonly mode: FieldPolicyModeStore;
  /**
   * Lookup of a single field's resolved policy by name.
   * Returns `undefined` when the field is not in the resolved set.
   */
  getField(fieldName: string): ResolvedFieldPolicy | undefined;
  /** Count of advanced-visible fields for the disclosure label. */
  readonly advancedFieldCount: number;
}

const FIELD_POLICY_CONTEXT_KEY = Symbol('smrt-field-policy-context');

/** Publish the context (called by FieldPolicyProvider). */
export function setFieldPolicyContext(context: FieldPolicyContextValue): void {
  setContext(FIELD_POLICY_CONTEXT_KEY, context);
}

/** Read the context, throwing when there is no Provider. */
export function getFieldPolicyContext(): FieldPolicyContextValue {
  const context = tryGetFieldPolicyContext();
  if (!context) {
    throw new Error(
      'FieldPolicy context not found. Wrap your form in ' +
        '<FieldPolicyProvider> from @happyvertical/smrt-fields/svelte.',
    );
  }
  return context;
}

/**
 * Optional reader — returns `undefined` when no Provider wraps the consumer.
 * Used by `PolicyField` so it can render children verbatim outside a Provider
 * (graceful degradation / incremental adoption).
 */
export function tryGetFieldPolicyContext():
  | FieldPolicyContextValue
  | undefined {
  return getContext<FieldPolicyContextValue | undefined>(
    FIELD_POLICY_CONTEXT_KEY,
  );
}
