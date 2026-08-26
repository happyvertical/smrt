/**
 * Transport-neutral interaction model for addressable form controls.
 *
 * The registry deliberately knows nothing about chat, agents, WebMCP, or the
 * DOM. Controls register serializable metadata plus small imperative handles;
 * adapters translate voice/chat/tutorial requests into commands.
 */

import { untrack } from 'svelte';

export type ControlKind =
  | 'text'
  | 'email'
  | 'password'
  | 'number'
  | 'date'
  | 'time'
  | 'datetime'
  | 'textarea'
  | 'select'
  | 'listbox'
  | 'combobox'
  | 'multi-select'
  | 'tags-input'
  | 'checkbox'
  | 'radio-group'
  | 'switch'
  | 'toggle-button'
  | 'slider'
  | 'range-slider'
  | 'segmented-control'
  | 'file'
  | 'custom';

export type ControlSensitivity = 'public' | 'personal' | 'sensitive' | 'secret';

export type ControlCapability =
  | 'read'
  | 'focus'
  | 'reveal'
  | 'highlight'
  | 'explain'
  | 'validate'
  | 'stage'
  | 'apply'
  | 'discard'
  | 'clear'
  | 'undo';

export interface ControlSubject {
  type: string;
  id: string;
  label?: string;
}

/** Stable address for a control, following AdminShell's Tool Identity pattern. */
export interface ControlIdentity {
  formId: string;
  controlId: string;
  subject?: ControlSubject;
}

export interface ControlOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface ControlConstraints {
  required?: boolean;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** Optional declarative metadata shared by every control primitive. */
export interface ControlInteractionOptions {
  /** Stable id inside the enclosing form. Defaults to name, then DOM id. */
  id?: string;
  description?: string;
  sensitivity?: ControlSensitivity;
  readable?: boolean;
  writable?: boolean;
  subject?: ControlSubject;
}

export interface ControlMetadata {
  kind: ControlKind;
  label?: string;
  description?: string;
  sensitivity?: ControlSensitivity;
  readable?: boolean;
  writable?: boolean;
  constraints?: ControlConstraints;
  options?: ControlOption[];
  unit?: string;
  capabilities?: ControlCapability[];
}

export interface ControlRuntimeState {
  disabled?: boolean;
  readonly?: boolean;
  valid?: boolean;
  validationMessage?: string;
}

export interface ControlStagedProvenance {
  source: ControlCommandSource;
  actorId?: string;
  sessionId?: string;
}

/** Reviewable metadata for a proposed value. The value is omitted when redacted. */
export interface ControlStagedEntry {
  value?: unknown;
  valueRedacted: boolean;
  provenance: ControlStagedProvenance;
  stagedAt: number;
  revision: number;
  stale: boolean;
  valid?: boolean;
  validationMessage?: string;
}

export interface ControlSnapshot {
  identity: ControlIdentity;
  metadata: ControlMetadata;
  state: ControlRuntimeState & {
    value?: unknown;
    valueRedacted: boolean;
    stagedValue?: unknown;
    stagedValueRedacted?: boolean;
    /** Canonical staged-value contract. Legacy stagedValue fields remain additive aliases. */
    staged?: ControlStagedEntry;
  };
}

export type ControlValueValidationResult =
  | boolean
  | string
  | { valid: boolean; message?: string };

export interface ControlRegistration {
  identity: ControlIdentity;
  metadata: ControlMetadata;
  getValue?: () => unknown;
  /**
   * Snapshot changed only by direct user edits. Async mutation rollback
   * restores a newer user value when this optional signal changes.
   */
  getUserEditSnapshot?: () => { revision: number; value: unknown };
  setValue?: (value: unknown) => void | Promise<void>;
  /** Resolve a staged intent against the current value without mutating it. */
  prepareValue?: (value: unknown) => unknown;
  /** Restore a value without re-running a fallible async mutation workflow. */
  restoreValue?: (value: unknown) => void | Promise<void>;
  /** Return true to affirm an accepted idempotent clear; false rejects it. */
  clear?: (() => void | Promise<void>) | (() => boolean | Promise<boolean>);
  focus?: () => void | Promise<void>;
  reveal?: () => void | Promise<void>;
  highlight?: (durationMs?: number) => void | Promise<void>;
  validate?: () => boolean | Promise<boolean>;
  /** Validate a proposal without mutating the bound value. */
  validateValue?: (
    value: unknown,
  ) => ControlValueValidationResult | Promise<ControlValueValidationResult>;
  getState?: () => ControlRuntimeState;
}

export type ControlCommandAction =
  | 'focus'
  | 'reveal'
  | 'highlight'
  | 'explain'
  | 'validate'
  | 'stage'
  | 'apply'
  | 'discard'
  | 'clear'
  | 'undo';

export type ControlCommand =
  | {
      action: 'focus' | 'reveal' | 'explain' | 'validate' | 'undo';
      identity: ControlIdentity;
    }
  | { action: 'highlight'; identity: ControlIdentity; durationMs?: number }
  | { action: 'stage'; identity: ControlIdentity; value: unknown }
  | {
      action: 'apply';
      identity: ControlIdentity;
      value?: unknown;
      /** Reject the command when this no longer matches the staged proposal. */
      revision?: number;
    }
  | { action: 'discard'; identity: ControlIdentity; revision?: number }
  | { action: 'clear'; identity: ControlIdentity };

export type ControlCommandSource =
  | 'user'
  | 'voice'
  | 'agent'
  | 'tutorial'
  | 'test';

export interface ControlCommandContext {
  source: ControlCommandSource;
  /** Advisory confirmation for legacy non-review mutations; never proves a local gesture. */
  confirmed?: boolean;
  /** Output-only audit marker set by the registry after validating a local gesture. */
  localGesture?: boolean;
  actorId?: string;
  sessionId?: string;
}

export interface ControlPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export type ControlInteractionPolicy = (
  command: ControlCommand,
  context: ControlCommandContext,
  snapshot: ControlSnapshot,
) => ControlPolicyDecision | Promise<ControlPolicyDecision>;

export interface ControlCommandResult {
  ok: boolean;
  action: ControlCommandAction;
  identity: ControlIdentity;
  snapshot?: ControlSnapshot;
  reason?: string;
}

export interface ControlBatchResult {
  ok: boolean;
  results: ControlCommandResult[];
}

export interface ControlInteractionEvent {
  type: 'registered' | 'unregistered' | 'staged' | 'command';
  identity: ControlIdentity;
  command?: ControlCommand;
  context?: ControlCommandContext;
  result?: ControlCommandResult;
  staged?: ControlStagedEntry;
  timestamp: number;
}

export interface ControlInteractionRegistry {
  register(registration: ControlRegistration): () => void;
  unregister(identity: ControlIdentity): void;
  /** Record a direct human edit observed by the owning form. */
  recordUserEdit?(identity: ControlIdentity): void;
  list(formId?: string): ControlSnapshot[];
  get(identity: ControlIdentity): ControlSnapshot | undefined;
  execute(
    command: ControlCommand,
    context?: ControlCommandContext,
  ): Promise<ControlCommandResult>;
  /** Executes in order and always returns an explicit result for every command. */
  executeBatch?(
    commands: ControlCommand[],
    context?: ControlCommandContext,
  ): Promise<ControlBatchResult>;
  subscribe(listener: (event: ControlInteractionEvent) => void): () => void;
}

export interface CreateControlInteractionRegistryOptions {
  policy?: ControlInteractionPolicy;
  now?: () => number;
  /** Host/test hook for recognizing a trusted local DOM gesture. Defaults to Event.isTrusted. */
  isLocalGesture?: (event: Event) => boolean;
}

type LocalGestureBatchExecutor = (
  commands: ControlCommand[],
  event: Event,
) => Promise<ControlBatchResult>;

const localGestureBatchExecutors = new WeakMap<
  ControlInteractionRegistry,
  LocalGestureBatchExecutor
>();
const consumedFallbackGestureEvents = new WeakMap<
  ControlInteractionRegistry,
  WeakSet<Event>
>();

/** Execute one value-changing command from a local DOM event handler. */
export function executeLocalControlCommand(
  registry: ControlInteractionRegistry,
  command: ControlCommand,
  event: Event,
): Promise<ControlCommandResult> {
  return executeLocalControlBatch(registry, [command], event).then(
    (batch) => batch.results[0],
  );
}

/** Execute an ordered best-effort batch from one local DOM event handler. */
export async function executeLocalControlBatch(
  registry: ControlInteractionRegistry,
  commands: ControlCommand[],
  event: Event,
): Promise<ControlBatchResult> {
  const executor = localGestureBatchExecutors.get(registry);
  if (!executor) {
    const consumed =
      consumedFallbackGestureEvents.get(registry) ?? new WeakSet<Event>();
    consumedFallbackGestureEvents.set(registry, consumed);
    if (!event.isTrusted || consumed.has(event)) {
      return {
        ok: false,
        results: commands.map((command) => ({
          ok: false,
          action: command.action,
          identity: cloneValue(command.identity),
          reason: 'local_gesture_required',
        })),
      };
    }
    consumed.add(event);
    const results: ControlCommandResult[] = [];
    for (const command of commands) {
      results.push(
        await registry.execute(command, {
          source: 'user',
          confirmed: true,
          localGesture: true,
        }),
      );
    }
    return { ok: results.every((entry) => entry.ok), results };
  }
  return executor(commands, event);
}

function identityKey(identity: ControlIdentity): string {
  return JSON.stringify([
    identity.formId,
    identity.controlId,
    identity.subject?.type ?? null,
    identity.subject?.id ?? null,
  ]);
}

function isMutation(action: ControlCommandAction): boolean {
  return ['stage', 'apply', 'discard', 'clear', 'undo'].includes(action);
}

function isSecret(registration: ControlRegistration): boolean {
  return registration.metadata.sensitivity === 'secret';
}

function capabilitiesOf(
  registration: ControlRegistration,
): ControlCapability[] {
  const declared = registration.metadata.capabilities;
  const capabilities: ControlCapability[] = declared ? [...declared] : [];
  if (!declared) {
    capabilities.push('explain');
    if (registration.getValue && registration.metadata.readable !== false) {
      capabilities.push('read');
    }
    if (registration.focus) capabilities.push('focus');
    if (registration.reveal) capabilities.push('reveal');
    if (registration.highlight) capabilities.push('highlight');
    if (registration.validate) capabilities.push('validate');
    if (registration.setValue && registration.metadata.writable !== false) {
      capabilities.push('stage', 'apply', 'discard', 'undo');
    }
    if (
      (registration.clear || registration.setValue) &&
      registration.metadata.writable !== false
    ) {
      capabilities.push('clear');
    }
  }
  return capabilities.filter((capability) => {
    if (capability === 'read') return !isSecret(registration);
    if (isMutation(capability)) return !isSecret(registration);
    return true;
  });
}

function redactsValue(registration: ControlRegistration): boolean {
  return (
    isSecret(registration) ||
    registration.metadata.sensitivity === 'sensitive' ||
    registration.metadata.readable === false
  );
}

function defaultPolicy(
  command: ControlCommand,
  context: ControlCommandContext,
  snapshot: ControlSnapshot,
  localGestureConfirmed: boolean,
): ControlPolicyDecision {
  if (!isMutation(command.action)) return { allowed: true };
  if (command.action !== 'discard') {
    if (snapshot.metadata.sensitivity === 'secret') {
      return { allowed: false, reason: 'sensitive_control' };
    }
    if (snapshot.metadata.writable === false) {
      return { allowed: false, reason: 'control_not_writable' };
    }
    if (snapshot.state.disabled || snapshot.state.readonly) {
      return { allowed: false, reason: 'control_not_editable' };
    }
  }
  if (context.source === 'agent' && command.action !== 'stage') {
    return { allowed: false, reason: 'human_confirmation_required' };
  }
  if (
    ['apply', 'discard', 'clear', 'undo'].includes(command.action) &&
    !localGestureConfirmed
  ) {
    return { allowed: false, reason: 'local_gesture_required' };
  }
  if (command.action !== 'stage' && !context.confirmed) {
    return { allowed: false, reason: 'consent_required' };
  }
  return { allowed: true };
}

interface InternalStagedEntry {
  value: unknown;
  baseValue: unknown;
  provenance: ControlStagedProvenance;
  stagedAt: number;
  revision: number;
  valid?: boolean;
  validationMessage?: string;
}

interface InternalUndoEntry {
  previousValue: unknown;
  appliedValue: unknown;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    if (value === undefined) return value;
    const serialized = JSON.stringify(value, (_key, candidate) => {
      if (
        typeof candidate === 'function' ||
        typeof candidate === 'symbol' ||
        typeof candidate === 'bigint'
      ) {
        throw new DOMException('Value is not cloneable', 'DataCloneError');
      }
      return candidate;
    });
    if (serialized === undefined) {
      throw new DOMException('Value is not cloneable', 'DataCloneError');
    }
    return JSON.parse(serialized) as T;
  }
}

function clonePublicValue<T>(value: T): T | undefined {
  try {
    return cloneValue(value);
  } catch {
    return undefined;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function userEditSuperseded(
  registration: ControlRegistration,
  previousUserEdit: ReturnType<
    NonNullable<ControlRegistration['getUserEditSnapshot']>
  > | null,
): boolean {
  if (!previousUserEdit) return false;
  const currentUserEdit = registration.getUserEditSnapshot?.();
  return (
    currentUserEdit !== undefined &&
    currentUserEdit.revision !== previousUserEdit.revision
  );
}

async function restoreRegistrationValue(
  registration: ControlRegistration,
  previousValue: unknown,
  previousUserEdit: ReturnType<
    NonNullable<ControlRegistration['getUserEditSnapshot']>
  > | null,
): Promise<void> {
  let observedUserEdit =
    cloneValue(registration.getUserEditSnapshot?.()) ?? null;
  let value =
    previousUserEdit &&
    observedUserEdit &&
    observedUserEdit.revision !== previousUserEdit.revision
      ? cloneValue(observedUserEdit.value)
      : previousValue;
  for (;;) {
    if (registration.restoreValue) {
      await registration.restoreValue(value);
    } else {
      await registration.setValue?.(value);
    }
    const latestUserEdit =
      cloneValue(registration.getUserEditSnapshot?.()) ?? null;
    if (
      !observedUserEdit ||
      !latestUserEdit ||
      latestUserEdit.revision === observedUserEdit.revision
    ) {
      return;
    }
    observedUserEdit = latestUserEdit;
    value = cloneValue(latestUserEdit.value);
  }
}

function redactedFailureReason(reason: string): string {
  return [
    'stale_revision',
    'staged_value_stale',
    'no_staged_value',
    'staged_value_invalid',
    'staged_value_rejected',
    'nothing_to_undo',
    'sensitive_control',
  ].includes(reason)
    ? reason
    : 'command_failed';
}

async function validateProposedValue(
  registration: ControlRegistration,
  value: unknown,
): Promise<{ valid?: boolean; validationMessage?: string }> {
  if (!registration.validateValue) return {};
  const validation = await registration.validateValue(value);
  if (typeof validation === 'boolean') return { valid: validation };
  if (typeof validation === 'string') {
    return { valid: false, validationMessage: validation };
  }
  return {
    valid: validation.valid,
    validationMessage: validation.message,
  };
}

/** Create an isolated registry; apps choose where and how it is exposed. */
export function createControlInteractionRegistry(
  options: CreateControlInteractionRegistryOptions = {},
): ControlInteractionRegistry {
  const registrations = new Map<string, ControlRegistration>();
  const staged = new Map<string, InternalStagedEntry>();
  const undo = new Map<string, InternalUndoEntry[]>();
  const userEdits = new Map<string, { revision: number; value: unknown }>();
  const registrationBaselines = new WeakMap<
    ControlRegistration,
    {
      value: unknown;
      userEdit: { revision: number; value: unknown } | null;
    }
  >();
  const activeSetterMutations = new Map<
    string,
    {
      registration: ControlRegistration;
      previousValue: unknown;
      immediateValue: unknown;
      previousUserEdit: { revision: number; value: unknown } | null;
    }
  >();
  const listeners = new Set<(event: ControlInteractionEvent) => void>();
  const now = options.now ?? Date.now;
  const locallyConfirmedContexts = new WeakSet<ControlCommandContext>();
  const internallyQueuedContexts = new WeakSet<ControlCommandContext>();
  const consumedLocalGestureEvents = new WeakSet<Event>();
  const mutationQueues = new Map<string, Promise<void>>();
  let stagedRevision = 0;

  const editAwareRegistration = (
    key: string,
    registration: ControlRegistration,
  ): ControlRegistration => ({
    ...registration,
    getUserEditSnapshot: () =>
      registration.getUserEditSnapshot?.() ??
      userEdits.get(key) ?? {
        revision: 0,
        value: registration.getValue?.(),
      },
  });

  const reconcileSupersededRegistration = async (
    key: string,
    registration: ControlRegistration,
    previousValue: unknown,
  ): Promise<boolean> => {
    const current = registrations.get(key);
    if (!current || current === registration) return false;
    const currentWithEdits = editAwareRegistration(key, current);
    const baseline = registrationBaselines.get(current) ?? {
      value: previousValue,
      userEdit: { revision: 0, value: cloneValue(previousValue) },
    };
    await restoreRegistrationValue(
      currentWithEdits,
      cloneValue(baseline.value),
      cloneValue(baseline.userEdit),
    );
    return true;
  };

  const enqueueMutation = <T>(key: string, operation: () => Promise<T>) => {
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(key, settled);
    void settled.finally(() => {
      if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
    });
    return pending;
  };

  const emit = (event: Omit<ControlInteractionEvent, 'timestamp'>) => {
    const next = { ...event, timestamp: now() };
    for (const listener of listeners) {
      try {
        listener(cloneValue(next));
      } catch {
        // Observers cannot change a command's committed result or registry state.
      }
    }
  };

  const snapshotOf = (registration: ControlRegistration): ControlSnapshot => {
    const key = identityKey(registration.identity);
    const redacted = redactsValue(registration);
    const stagedEntry = staged.get(key);
    const stale = stagedEntry
      ? !valuesEqual(stagedEntry.baseValue, registration.getValue?.())
      : false;
    const runtimeState = registration.getState?.();
    const publicStaged: ControlStagedEntry | undefined = stagedEntry
      ? {
          value: redacted ? undefined : cloneValue(stagedEntry.value),
          valueRedacted: redacted,
          provenance: { ...stagedEntry.provenance },
          stagedAt: stagedEntry.stagedAt,
          revision: stagedEntry.revision,
          stale,
          valid: stagedEntry.valid,
          validationMessage: redacted
            ? undefined
            : stagedEntry.validationMessage,
        }
      : undefined;
    const rawValue = redacted ? undefined : registration.getValue?.();
    const publicValue = redacted ? undefined : clonePublicValue(rawValue);
    return {
      identity: cloneValue(registration.identity),
      metadata: {
        ...registration.metadata,
        capabilities: capabilitiesOf(registration),
        constraints: registration.metadata.constraints
          ? { ...registration.metadata.constraints }
          : undefined,
        options: registration.metadata.options?.map((option) => ({
          ...option,
        })),
      },
      state: {
        ...runtimeState,
        validationMessage: redacted
          ? undefined
          : runtimeState?.validationMessage,
        value: publicValue,
        valueRedacted:
          redacted || (rawValue !== undefined && publicValue === undefined),
        stagedValue: publicStaged?.value,
        stagedValueRedacted: publicStaged?.valueRedacted,
        staged: publicStaged,
      },
    };
  };

  const result = (
    command: ControlCommand,
    ok: boolean,
    registration?: ControlRegistration,
    reason?: string,
  ): ControlCommandResult => {
    let snapshot: ControlSnapshot | undefined;
    try {
      snapshot = registration ? snapshotOf(registration) : undefined;
    } catch {
      // A broken control reader must not prevent a structured command result.
    }
    return {
      ok,
      action: command.action,
      identity: cloneValue(command.identity),
      snapshot,
      reason,
    };
  };

  const registry: ControlInteractionRegistry = {
    register(registration) {
      const key = identityKey(registration.identity);
      // Capture synchronously so an already-released superseded setter cannot
      // overwrite the replacement generation before its baseline is recorded.
      // `untrack` keeps this read out of a caller's reactive registration effect.
      untrack(() => {
        try {
          const currentValue = cloneValue(registration.getValue?.());
          const activeMutation = activeSetterMutations.get(key);
          const userEdit = cloneValue(
            registration.getUserEditSnapshot?.() ?? userEdits.get(key),
          );
          const newerUserEdit =
            activeMutation &&
            userEdit &&
            (!activeMutation.previousUserEdit ||
              userEdit.revision !== activeMutation.previousUserEdit.revision);
          const value =
            activeMutation &&
            registrations.get(key) === activeMutation.registration &&
            valuesEqual(currentValue, activeMutation.immediateValue) &&
            !newerUserEdit
              ? cloneValue(activeMutation.previousValue)
              : currentValue;
          registrationBaselines.set(registration, {
            value,
            userEdit: userEdit ?? { revision: 0, value: cloneValue(value) },
          });
        } catch {
          // A broken reader is handled by command execution, not registration.
        }
      });
      registrations.set(key, registration);
      emit({ type: 'registered', identity: registration.identity });
      return () => {
        if (registrations.get(key) !== registration) return;
        registrations.delete(key);
        staged.delete(key);
        undo.delete(key);
        userEdits.delete(key);
        emit({ type: 'unregistered', identity: registration.identity });
      };
    },

    unregister(identity) {
      const key = identityKey(identity);
      if (!registrations.delete(key)) return;
      staged.delete(key);
      undo.delete(key);
      userEdits.delete(key);
      emit({ type: 'unregistered', identity });
    },

    recordUserEdit(identity) {
      const key = identityKey(identity);
      const registration = registrations.get(key);
      if (!registration) return;
      const previous = userEdits.get(key);
      userEdits.set(key, {
        revision: (previous?.revision ?? 0) + 1,
        value: cloneValue(registration.getValue?.()),
      });
    },

    list(formId) {
      return [...registrations.values()]
        .filter((registration) =>
          formId ? registration.identity.formId === formId : true,
        )
        .map(snapshotOf);
    },

    get(identity) {
      const registration = registrations.get(identityKey(identity));
      return registration ? snapshotOf(registration) : undefined;
    },

    async execute(command, context = { source: 'user', confirmed: true }) {
      const key = identityKey(command.identity);
      if (
        isMutation(command.action) &&
        !internallyQueuedContexts.has(context)
      ) {
        const queuedContext: ControlCommandContext = { ...context };
        internallyQueuedContexts.add(queuedContext);
        if (locallyConfirmedContexts.has(context)) {
          locallyConfirmedContexts.add(queuedContext);
        }
        return enqueueMutation(key, () => this.execute(command, queuedContext));
      }
      const registration = registrations.get(key);
      if (!registration) return result(command, false, undefined, 'not_found');
      const registrationWithEdits = editAwareRegistration(key, registration);
      const restoreMutationValue = async (
        previousValue: unknown,
        previousUserEdit: ReturnType<
          NonNullable<ControlRegistration['getUserEditSnapshot']>
        > | null,
      ) => {
        if (
          await reconcileSupersededRegistration(
            key,
            registration,
            previousValue,
          )
        ) {
          return;
        }
        await restoreRegistrationValue(
          registrationWithEdits,
          previousValue,
          previousUserEdit,
        );
      };
      const publicCommand: ControlCommand =
        redactsValue(registration) &&
        (command.action === 'stage' || command.action === 'apply')
          ? cloneValue({ ...command, value: undefined })
          : cloneValue(command);
      const publicContext: ControlCommandContext = {
        source: context.source,
        confirmed: context.confirmed,
        localGesture: locallyConfirmedContexts.has(context),
        actorId: context.actorId,
        sessionId: context.sessionId,
      };

      try {
        const snapshot = snapshotOf(registration);
        const commandUserEditSnapshot =
          command.action === 'apply' ||
          command.action === 'clear' ||
          command.action === 'undo'
            ? (cloneValue(registrationWithEdits.getUserEditSnapshot?.()) ??
              null)
            : null;
        const invariantDecision = defaultPolicy(
          command,
          publicContext,
          snapshot,
          publicContext.localGesture === true,
        );
        const policyDecision =
          invariantDecision.allowed && options.policy
            ? await options.policy(
                cloneValue(publicCommand),
                cloneValue(publicContext),
                cloneValue(snapshot),
              )
            : invariantDecision;
        if (registrations.get(key) !== registration) {
          throw new Error('staged_value_stale');
        }
        if (
          commandUserEditSnapshot &&
          userEditSuperseded(registrationWithEdits, commandUserEditSnapshot)
        ) {
          throw new Error('staged_value_stale');
        }
        const postPolicyInvariant = defaultPolicy(
          command,
          publicContext,
          snapshotOf(registration),
          publicContext.localGesture === true,
        );
        if (!postPolicyInvariant.allowed) {
          throw new Error(postPolicyInvariant.reason ?? 'denied');
        }
        if (!policyDecision.allowed) {
          const denialReason = redactsValue(registration)
            ? redactedFailureReason(policyDecision.reason ?? 'denied')
            : (policyDecision.reason ?? 'denied');
          const denied = result(command, false, registration, denialReason);
          emit({
            type: 'command',
            identity: command.identity,
            command: publicCommand,
            context: publicContext,
            result: denied,
          });
          return denied;
        }

        const capabilities = capabilitiesOf(registration);
        if (!capabilities.includes(command.action)) {
          const unsupported = result(
            command,
            false,
            registration,
            'unsupported',
          );
          emit({
            type: 'command',
            identity: command.identity,
            command: publicCommand,
            context: publicContext,
            result: unsupported,
          });
          return unsupported;
        }

        switch (command.action) {
          case 'focus':
            await registration.focus?.();
            break;
          case 'reveal':
            await registration.reveal?.();
            break;
          case 'highlight':
            await registration.highlight?.(command.durationMs);
            break;
          case 'explain':
            break;
          case 'validate':
            await registration.validate?.();
            break;
          case 'stage':
            stagedRevision += 1;
            {
              const revision = stagedRevision;
              const preparedValue = registration.prepareValue
                ? registration.prepareValue(command.value)
                : command.value;
              const entry: InternalStagedEntry = {
                value: cloneValue(preparedValue),
                baseValue: cloneValue(registration.getValue?.()),
                provenance: {
                  source: context.source,
                  actorId: context.actorId,
                  sessionId: context.sessionId,
                },
                stagedAt: now(),
                revision,
              };
              const previousEntry = staged.get(key);
              staged.set(key, entry);
              try {
                const validation = await validateProposedValue(
                  registration,
                  preparedValue,
                );
                if (
                  registrations.get(key) !== registration ||
                  staged.get(key) !== entry
                ) {
                  throw new Error('stale_revision');
                }
                Object.assign(entry, validation);
                const stageSnapshot = snapshotOf(registration);
                const completed: ControlCommandResult = {
                  ok: true,
                  action: command.action,
                  identity: { ...command.identity },
                  snapshot: stageSnapshot,
                };
                emit({
                  type: 'staged',
                  identity: command.identity,
                  command: publicCommand,
                  context: publicContext,
                  staged: stageSnapshot.state.staged,
                });
                emit({
                  type: 'command',
                  identity: command.identity,
                  command: publicCommand,
                  context: publicContext,
                  result: completed,
                });
                return completed;
              } catch (error) {
                if (staged.get(key) === entry) {
                  if (previousEntry) {
                    staged.set(key, previousEntry);
                  } else {
                    staged.delete(key);
                  }
                }
                throw error;
              }
            }
          case 'apply': {
            const stagedEntry = staged.get(key);
            if (
              command.revision !== undefined &&
              stagedEntry?.revision !== command.revision
            ) {
              throw new Error('stale_revision');
            }
            if (
              stagedEntry &&
              !valuesEqual(stagedEntry.baseValue, registration.getValue?.())
            ) {
              throw new Error('staged_value_stale');
            }
            const nextValue =
              'value' in command && command.value !== undefined
                ? command.value
                : stagedEntry?.value;
            if (nextValue === undefined && !stagedEntry) {
              throw new Error('no_staged_value');
            }
            const proposedValidation = await validateProposedValue(
              registration,
              nextValue,
            );
            if (registrations.get(key) !== registration) {
              throw new Error('staged_value_stale');
            }
            if (
              commandUserEditSnapshot &&
              userEditSuperseded(registrationWithEdits, commandUserEditSnapshot)
            ) {
              throw new Error('staged_value_stale');
            }
            if (
              stagedEntry &&
              (staged.get(key) !== stagedEntry ||
                !valuesEqual(stagedEntry.baseValue, registration.getValue?.()))
            ) {
              throw new Error('stale_revision');
            }
            if (proposedValidation.valid === false) {
              if (stagedEntry) Object.assign(stagedEntry, proposedValidation);
              throw new Error(
                redactsValue(registration)
                  ? 'staged_value_invalid'
                  : (proposedValidation.validationMessage ??
                      'staged_value_invalid'),
              );
            }
            const preMutationInvariant = defaultPolicy(
              command,
              publicContext,
              snapshotOf(registration),
              publicContext.localGesture === true,
            );
            if (!preMutationInvariant.allowed) {
              throw new Error(preMutationInvariant.reason ?? 'denied');
            }
            const previousValue = cloneValue(registration.getValue?.());
            const history = undo.get(key) ?? [];
            const userEditSnapshot = commandUserEditSnapshot;
            const activeSetterMutation = {
              registration,
              previousValue: cloneValue(previousValue),
              immediateValue: cloneValue(previousValue),
              previousUserEdit: cloneValue(userEditSnapshot),
            };
            try {
              activeSetterMutations.set(key, activeSetterMutation);
              const setterResult = registration.setValue?.(nextValue);
              activeSetterMutation.immediateValue = cloneValue(
                registration.getValue?.(),
              );
              await setterResult;
            } catch (error) {
              try {
                await restoreMutationValue(previousValue, userEditSnapshot);
              } catch {
                // Preserve the original setter failure for the command result.
              }
              throw error;
            } finally {
              if (activeSetterMutations.get(key) === activeSetterMutation) {
                activeSetterMutations.delete(key);
              }
            }
            if (
              registrations.get(key) !== registration ||
              userEditSuperseded(registrationWithEdits, userEditSnapshot)
            ) {
              await restoreMutationValue(previousValue, userEditSnapshot);
              throw new Error('staged_value_stale');
            }
            const appliedValue = cloneValue(registration.getValue?.());
            if (
              valuesEqual(appliedValue, previousValue) &&
              !valuesEqual(nextValue, previousValue)
            ) {
              throw new Error('staged_value_rejected');
            }
            try {
              const valid = await registration.validate?.();
              if (
                registrations.get(key) !== registration ||
                userEditSuperseded(registrationWithEdits, userEditSnapshot)
              ) {
                throw new Error('staged_value_stale');
              }
              if (!valuesEqual(registration.getValue?.(), appliedValue)) {
                throw new Error('staged_value_stale');
              }
              if (valid === false) {
                if (stagedEntry) {
                  stagedEntry.valid = false;
                  stagedEntry.validationMessage =
                    registration.getState?.().validationMessage ??
                    'staged_value_invalid';
                }
                throw new Error('staged_value_invalid');
              }
            } catch (error) {
              let currentValue: unknown;
              try {
                currentValue = registration.getValue?.();
              } catch {
                // A broken reader is reported without attempting a blind overwrite.
              }
              if (valuesEqual(currentValue, appliedValue)) {
                try {
                  await restoreMutationValue(previousValue, userEditSnapshot);
                } catch {
                  // Preserve the original validation failure for the command result.
                }
              }
              throw error;
            }
            history.push({
              previousValue,
              appliedValue,
            });
            undo.set(key, history);
            if (!stagedEntry || staged.get(key) === stagedEntry) {
              staged.delete(key);
            }
            break;
          }
          case 'discard': {
            const stagedEntry = staged.get(key);
            if (!stagedEntry) throw new Error('no_staged_value');
            if (
              command.revision !== undefined &&
              stagedEntry.revision !== command.revision
            ) {
              throw new Error('stale_revision');
            }
            staged.delete(key);
            break;
          }
          case 'clear': {
            const previousValue = cloneValue(registration.getValue?.());
            let clearDecision: boolean | undefined;
            const userEditSnapshot = commandUserEditSnapshot;
            try {
              const pendingDecision = registration.clear
                ? registration.clear()
                : registration.setValue?.('');
              const decision = await pendingDecision;
              clearDecision =
                decision === true
                  ? true
                  : decision === false
                    ? false
                    : undefined;
            } catch (error) {
              try {
                await restoreMutationValue(previousValue, userEditSnapshot);
              } catch {
                // Preserve the original clear failure for the command result.
              }
              throw error;
            }
            if (
              registrations.get(key) !== registration ||
              userEditSuperseded(registrationWithEdits, userEditSnapshot)
            ) {
              await restoreMutationValue(previousValue, userEditSnapshot);
              throw new Error('staged_value_stale');
            }
            const clearedValue = registration.getValue?.();
            const rejected =
              clearDecision === false ||
              (clearDecision !== true &&
                valuesEqual(clearedValue, previousValue) &&
                previousValue !== '' &&
                previousValue !== null &&
                previousValue !== undefined &&
                previousValue !== false &&
                !(Array.isArray(previousValue) && previousValue.length === 0));
            if (rejected) {
              try {
                await restoreMutationValue(previousValue, userEditSnapshot);
              } catch {
                // The rejected command still retains its proposal for recovery.
              }
              throw new Error('staged_value_rejected');
            }
            const history = undo.get(key) ?? [];
            history.push({
              previousValue,
              appliedValue: cloneValue(clearedValue),
            });
            undo.set(key, history);
            staged.delete(key);
            break;
          }
          case 'undo': {
            const history = undo.get(key) ?? [];
            if (history.length === 0) throw new Error('nothing_to_undo');
            const undoEntry = history.at(-1);
            if (!undoEntry) throw new Error('nothing_to_undo');
            const currentValue = cloneValue(registration.getValue?.());
            const userEditSnapshot = commandUserEditSnapshot;
            if (!valuesEqual(currentValue, undoEntry.appliedValue)) {
              throw new Error('staged_value_stale');
            }
            try {
              await registration.setValue?.(undoEntry.previousValue);
            } catch (error) {
              try {
                await restoreMutationValue(currentValue, userEditSnapshot);
              } catch {
                // Preserve the original setter failure for the command result.
              }
              throw error;
            }
            if (
              registrations.get(key) !== registration ||
              userEditSuperseded(registrationWithEdits, userEditSnapshot)
            ) {
              await restoreMutationValue(currentValue, userEditSnapshot);
              throw new Error('staged_value_stale');
            }
            if (
              !valuesEqual(registration.getValue?.(), undoEntry.previousValue)
            ) {
              try {
                await restoreMutationValue(currentValue, userEditSnapshot);
              } catch {
                // Preserve the rejected undo result while retaining its history.
              }
              throw new Error('staged_value_rejected');
            }
            history.pop();
            undo.set(key, history);
            break;
          }
        }
        const completed = result(command, true, registration);
        emit({
          type: 'command',
          identity: command.identity,
          command: publicCommand,
          context: publicContext,
          result: completed,
        });
        return completed;
      } catch (error) {
        const errorReason =
          error instanceof Error ? error.message : 'command_failed';
        const failed = result(
          command,
          false,
          registration,
          redactsValue(registration)
            ? redactedFailureReason(errorReason)
            : errorReason,
        );
        emit({
          type: 'command',
          identity: command.identity,
          command: publicCommand,
          context: publicContext,
          result: failed,
        });
        return failed;
      }
    },

    async executeBatch(
      commands,
      context = { source: 'user', confirmed: true },
    ) {
      const results: ControlCommandResult[] = [];
      for (const command of commands) {
        results.push(await this.execute(command, context));
      }
      return { ok: results.every((entry) => entry.ok), results };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  localGestureBatchExecutors.set(registry, async (commands, event) => {
    const isLocalGesture =
      options.isLocalGesture ?? ((candidate: Event) => candidate.isTrusted);
    if (!isLocalGesture(event) || consumedLocalGestureEvents.has(event)) {
      return {
        ok: false,
        results: commands.map((command) =>
          result(
            command,
            false,
            registrations.get(identityKey(command.identity)),
            'local_gesture_required',
          ),
        ),
      };
    }
    consumedLocalGestureEvents.add(event);
    const results: ControlCommandResult[] = [];
    for (const command of commands) {
      const context: ControlCommandContext = {
        source: 'user',
        confirmed: true,
      };
      locallyConfirmedContexts.add(context);
      results.push(await registry.execute(command, context));
    }
    return { ok: results.every((entry) => entry.ok), results };
  });

  return registry;
}
