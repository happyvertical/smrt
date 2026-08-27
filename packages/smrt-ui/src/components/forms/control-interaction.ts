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
  /** Context-aware alternative to setValue; legacy setters keep one argument. */
  setValueWithContext?: (
    value: unknown,
    context: ControlExtensionContext,
  ) => void | Promise<void>;
  /**
   * Resolve a staged intent against the current value without mutating it.
   * May throw when the control cannot represent the intent canonically.
   */
  prepareValue?: (value: unknown) => unknown;
  /** Restore a value without re-running a fallible async mutation workflow. */
  restoreValue?: (
    value: unknown,
    context?: ControlExtensionContext,
  ) => void | Promise<void>;
  /** Return true to affirm an accepted idempotent clear; false rejects it. */
  clear?:
    | ((context?: ControlExtensionContext) => void | Promise<void>)
    | ((context?: ControlExtensionContext) => boolean | Promise<boolean>);
  focus?: () => void | Promise<void>;
  reveal?: () => void | Promise<void>;
  highlight?: (durationMs?: number) => void | Promise<void>;
  validate?: (context?: ControlExtensionContext) => boolean | Promise<boolean>;
  /** Validate a proposal without mutating the bound value. */
  validateValue?: (
    value: unknown,
    context?: ControlExtensionContext,
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

/**
 * Execution utilities supplied to registry extension hooks. Same-control
 * mutations are rejected before queuing so an extension cannot await its own
 * mutation and deadlock the ordered command queue.
 */
export interface ControlExtensionContext {
  execute(
    command: ControlCommand,
    context?: ControlCommandContext,
  ): Promise<ControlCommandResult>;
}

export type ControlInteractionPolicy = (
  command: ControlCommand,
  context: ControlCommandContext,
  snapshot: ControlSnapshot,
  extensionContext?: ControlExtensionContext,
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
  type: 'registered' | 'unregistered' | 'refreshed' | 'staged' | 'command';
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
  /** Notify consumers that live registration metadata or runtime state changed. */
  refresh?(formId?: string): void;
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
  /** Host/test trust hook. Active DOM dispatch is always required independently. */
  isLocalGesture?: (event: Event) => boolean;
  /** @deprecated Reentrant mutations are rejected through ControlExtensionContext. */
  reentrantMutationTimeoutMs?: number;
}

type LocalGestureBatchExecutor = (
  registry: ControlInteractionRegistry,
  commands: ControlCommand[],
  event: Event,
) => Promise<ControlBatchResult>;

const localGestureBatchExecutors = new WeakMap<
  ControlInteractionRegistry,
  LocalGestureBatchExecutor
>();
// Intentionally module-private: enumerable so transparent object-spread
// registry adapters retain the same one-shot local-gesture proof path.
const localGestureBatchExecutor = Symbol('smrt.localGestureBatchExecutor');
type LocalGestureExecutorCarrier = {
  [localGestureBatchExecutor]?: LocalGestureBatchExecutor;
};
const consumedFallbackGestureEvents = new WeakMap<
  ControlInteractionRegistry,
  WeakSet<Event>
>();

const eventIsTrustedGetter =
  typeof Event === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted')?.get;
const eventPhaseGetter =
  typeof Event === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(Event.prototype, 'eventPhase')?.get;

function nativeEventState(
  event: Event,
): { isTrusted: boolean; eventPhase: number } | undefined {
  const ownIsTrusted = Object.getOwnPropertyDescriptor(event, 'isTrusted');
  if (
    !eventPhaseGetter ||
    Object.hasOwn(event, 'eventPhase') ||
    (eventIsTrustedGetter && ownIsTrusted) ||
    (!eventIsTrustedGetter &&
      (!ownIsTrusted || ownIsTrusted.configurable || ownIsTrusted.writable))
  ) {
    return undefined;
  }
  try {
    return {
      isTrusted: eventIsTrustedGetter
        ? Boolean(eventIsTrustedGetter.call(event))
        : Boolean(
            ownIsTrusted && 'get' in ownIsTrusted
              ? ownIsTrusted.get?.call(event)
              : ownIsTrusted?.value,
          ),
      eventPhase: Number(eventPhaseGetter.call(event)),
    };
  } catch {
    // Native prototype getters reject plain objects and incompatible receivers.
    return undefined;
  }
}

function cloneFailureResult(command: ControlCommand): ControlCommandResult {
  let action: ControlCommandAction = 'stage';
  let identity: ControlIdentity = { formId: '', controlId: '' };
  try {
    action = command.action;
  } catch {
    // A hostile accessor must not turn clone rejection into a thrown error.
  }
  try {
    const source = command.identity;
    identity = {
      formId: source.formId,
      controlId: source.controlId,
      ...(source.subject
        ? {
            subject: {
              type: source.subject.type,
              id: source.subject.id,
              ...(source.subject.label === undefined
                ? {}
                : { label: source.subject.label }),
            },
          }
        : {}),
    };
  } catch {
    // Preserve the structured failure shape without retaining caller aliases.
  }
  return {
    ok: false,
    action,
    identity,
    reason: 'command_failed',
  };
}

function cloneCommandBatch(
  commands: ControlCommand[],
): ControlCommand[] | undefined {
  try {
    return cloneValue(commands);
  } catch {
    return undefined;
  }
}

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
  const commandSnapshots = cloneCommandBatch(commands);
  if (!commandSnapshots) {
    const results = commands.map(cloneFailureResult);
    return { ok: false, results };
  }
  const executor =
    localGestureBatchExecutors.get(registry) ??
    (registry as ControlInteractionRegistry & LocalGestureExecutorCarrier)[
      localGestureBatchExecutor
    ];
  if (!executor) {
    const consumed =
      consumedFallbackGestureEvents.get(registry) ?? new WeakSet<Event>();
    consumedFallbackGestureEvents.set(registry, consumed);
    const eventState = nativeEventState(event);
    if (
      !eventState?.isTrusted ||
      eventState.eventPhase === 0 ||
      consumed.has(event)
    ) {
      return {
        ok: false,
        results: commandSnapshots.map((command) => ({
          ok: false,
          action: command.action,
          identity: cloneValue(command.identity),
          reason: 'local_gesture_required',
        })),
      };
    }
    consumed.add(event);
    const results: ControlCommandResult[] = [];
    for (const command of commandSnapshots) {
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
  return executor(registry, commandSnapshots, event);
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

function hasValueSetter(registration: ControlRegistration): boolean {
  return Boolean(registration.setValueWithContext || registration.setValue);
}

function setRegistrationValue(
  registration: ControlRegistration,
  value: unknown,
  context: ControlExtensionContext,
): void | Promise<void> | undefined {
  return registration.setValueWithContext
    ? registration.setValueWithContext(value, context)
    : registration.setValue?.(value);
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
    if (hasValueSetter(registration)) {
      capabilities.push('discard');
      if (registration.metadata.writable !== false) {
        capabilities.push('stage', 'apply', 'undo');
      }
    }
    if (
      (registration.clear || hasValueSetter(registration)) &&
      registration.metadata.writable !== false
    ) {
      capabilities.push('clear');
    }
  }
  return capabilities.filter((capability) => {
    if (capability === 'read') return !isSecret(registration);
    if (capability === 'discard') return true;
    if (isMutation(capability)) {
      return (
        !isSecret(registration) && registration.metadata.writable !== false
      );
    }
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
  invokeExtension: <T>(invoke: (context: ControlExtensionContext) => T) => T,
): Promise<void> {
  let observedUserEdit =
    cloneValue(registration.getUserEditSnapshot?.()) ?? null;
  let value =
    previousUserEdit &&
    observedUserEdit &&
    observedUserEdit.revision !== previousUserEdit.revision
      ? cloneValue(observedUserEdit.value)
      : previousValue;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (registration.restoreValue) {
      await invokeExtension((context) =>
        registration.restoreValue?.(value, context),
      );
    } else {
      await invokeExtension((context) =>
        setRegistrationValue(registration, value, context),
      );
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
    if (attempt === 7) {
      // The bounded replay just observed a newer human value after the final
      // restorer completed. Hand that value to the control once more without
      // retrying. Keep using the infallible restoration path when one was
      // supplied: the ordinary setter may be the fallible workflow that
      // triggered rollback in the first place.
      if (registration.restoreValue) {
        await invokeExtension((context) =>
          registration.restoreValue?.(value, context),
        );
      } else if (hasValueSetter(registration)) {
        await invokeExtension((context) =>
          setRegistrationValue(registration, value, context),
        );
      }
      return;
    }
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
  context: ControlExtensionContext,
): Promise<{ valid?: boolean; validationMessage?: string }> {
  if (!registration.validateValue) return {};
  // Validators are untrusted extension points. Never expose the registry's
  // stored proposal or the candidate that will later be passed to the setter.
  const validation = await registration.validateValue(
    cloneValue(value),
    context,
  );
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
  const registrationGenerations = new Map<string, object>();
  const staged = new Map<string, InternalStagedEntry>();
  const undo = new Map<string, InternalUndoEntry[]>();
  const userEdits = new Map<string, { revision: number; value: unknown }>();
  const registrationBaselines = new WeakMap<
    object,
    {
      value: unknown;
      userEdit: { revision: number; value: unknown } | null;
    }
  >();
  const activeValueMutations = new Map<
    string,
    {
      registration: ControlRegistration;
      generation: object;
      previousValue: unknown;
      immediateValue: unknown;
      previousUserEdit: { revision: number; value: unknown } | null;
    }
  >();
  const listeners = new Set<(event: ControlInteractionEvent) => void>();
  const now = options.now ?? Date.now;
  // The context itself is never authority. This private, one-use grant is
  // object-identity bound to the exact command handed to an adapter, retains a
  // private immutable snapshot to detect in-place substitution, and is also
  // bound to the registration generation present during the gesture.
  const localConfirmationGrants = new WeakMap<
    ControlCommandContext,
    {
      command: ControlCommand;
      snapshot: ControlCommand;
      generation: object | undefined;
    }
  >();
  const internallyQueuedContexts = new WeakSet<ControlCommandContext>();
  const consumedLocalGestureEvents = new WeakSet<Event>();
  const mutationQueues = new Map<string, Promise<void>>();
  const synchronousExtensionDepth = new Map<string, number>();
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

  const invokeExtension = <T>(
    key: string,
    invoke: (context: ControlExtensionContext) => T,
  ): T => {
    synchronousExtensionDepth.set(
      key,
      (synchronousExtensionDepth.get(key) ?? 0) + 1,
    );
    const releaseDepth = (depths: Map<string, number>) => {
      const remaining = (depths.get(key) ?? 1) - 1;
      if (remaining === 0) {
        depths.delete(key);
      } else {
        depths.set(key, remaining);
      }
    };
    const extensionContext: ControlExtensionContext = {
      execute(command, context = { source: 'agent' }) {
        if (
          isMutation(command.action) &&
          identityKey(command.identity) === key
        ) {
          const registration = registrations.get(key);
          return Promise.resolve(
            result(
              command,
              false,
              registration,
              registration && redactsValue(registration)
                ? 'command_failed'
                : 'reentrant_mutation',
            ),
          );
        }
        return registry.execute(command, context);
      },
    };
    let returned: T;
    try {
      returned = invoke(extensionContext);
    } catch (error) {
      releaseDepth(synchronousExtensionDepth);
      throw error;
    }
    releaseDepth(synchronousExtensionDepth);
    return returned;
  };

  const reconcileSupersededRegistration = async (
    key: string,
    generation: object,
    previousValue: unknown,
  ): Promise<boolean> => {
    const current = registrations.get(key);
    const currentGeneration = registrationGenerations.get(key);
    if (!current || !currentGeneration || currentGeneration === generation) {
      return false;
    }
    const currentWithEdits = editAwareRegistration(key, current);
    const baseline = registrationBaselines.get(currentGeneration) ?? {
      value: previousValue,
      userEdit: { revision: 0, value: cloneValue(previousValue) },
    };
    await restoreRegistrationValue(
      currentWithEdits,
      cloneValue(baseline.value),
      cloneValue(baseline.userEdit),
      (invoke) => invokeExtension(key, invoke),
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

  const invokeTrackedValueMutation = async <T>(
    key: string,
    registration: ControlRegistration,
    generation: object,
    previousValue: unknown,
    previousUserEdit: { revision: number; value: unknown } | null,
    invoke: (context: ControlExtensionContext) => T | Promise<T>,
  ): Promise<T> => {
    const activeMutation = {
      registration,
      generation,
      previousValue: cloneValue(previousValue),
      immediateValue: cloneValue(previousValue),
      previousUserEdit: cloneValue(previousUserEdit),
    };
    try {
      activeValueMutations.set(key, activeMutation);
      const pending = invokeExtension(key, invoke);
      activeMutation.immediateValue = cloneValue(registration.getValue?.());
      return await pending;
    } finally {
      if (activeValueMutations.get(key) === activeMutation) {
        activeValueMutations.delete(key);
      }
    }
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
    const publicStaged: ControlStagedEntry | undefined =
      stagedEntry &&
      !isSecret(registration) &&
      registration.metadata.writable !== false
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
        ...(publicStaged
          ? {
              stagedValue: publicStaged.value,
              stagedValueRedacted: publicStaged.valueRedacted,
              staged: publicStaged,
            }
          : {}),
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
      const generation = {};
      // Capture synchronously so an already-released superseded setter cannot
      // overwrite the replacement generation before its baseline is recorded.
      // `untrack` keeps this read out of a caller's reactive registration effect.
      untrack(() => {
        try {
          const currentValue = cloneValue(registration.getValue?.());
          const activeMutation = activeValueMutations.get(key);
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
            registrationGenerations.get(key) === activeMutation.generation &&
            (registration === activeMutation.registration ||
              valuesEqual(currentValue, activeMutation.immediateValue)) &&
            !newerUserEdit
              ? cloneValue(activeMutation.previousValue)
              : currentValue;
          registrationBaselines.set(generation, {
            value,
            userEdit: userEdit ?? { revision: 0, value: cloneValue(value) },
          });
        } catch {
          // A broken reader is handled by command execution, not registration.
        }
      });
      registrations.set(key, registration);
      registrationGenerations.set(key, generation);
      emit({ type: 'registered', identity: registration.identity });
      return () => {
        if (registrationGenerations.get(key) !== generation) return;
        registrations.delete(key);
        registrationGenerations.delete(key);
        staged.delete(key);
        undo.delete(key);
        userEdits.delete(key);
        emit({ type: 'unregistered', identity: registration.identity });
      };
    },

    unregister(identity) {
      const key = identityKey(identity);
      if (!registrations.delete(key)) return;
      registrationGenerations.delete(key);
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

    refresh(formId) {
      for (const registration of registrations.values()) {
        if (formId && registration.identity.formId !== formId) continue;
        emit({ type: 'refreshed', identity: registration.identity });
      }
    },

    async execute(command, context = { source: 'user', confirmed: true }) {
      const suppliedCommand = command;
      const localGrant = localConfirmationGrants.get(context);
      if (localGrant) localConfirmationGrants.delete(context);
      if (!internallyQueuedContexts.has(context)) {
        try {
          command = cloneValue(command);
        } catch {
          return cloneFailureResult(command);
        }
      }
      const key = identityKey(command.identity);
      if (
        isMutation(command.action) &&
        (synchronousExtensionDepth.get(key) ?? 0) > 0
      ) {
        const registration = registrations.get(key);
        return result(
          command,
          false,
          registration,
          registration && redactsValue(registration)
            ? 'command_failed'
            : 'reentrant_mutation',
        );
      }
      const localGestureConfirmed = Boolean(
        localGrant &&
          localGrant.command === suppliedCommand &&
          valuesEqual(localGrant.snapshot, command) &&
          localGrant.generation === registrationGenerations.get(key),
      );
      if (
        isMutation(command.action) &&
        !internallyQueuedContexts.has(context)
      ) {
        const queuedContext: ControlCommandContext = { ...context };
        internallyQueuedContexts.add(queuedContext);
        const commandSnapshot = command;
        if (localGestureConfirmed) {
          localConfirmationGrants.set(queuedContext, {
            command: commandSnapshot,
            snapshot: cloneValue(commandSnapshot),
            generation: localGrant?.generation,
          });
        }
        return await enqueueMutation(key, () =>
          this.execute(commandSnapshot, queuedContext),
        );
      }
      const registration = registrations.get(key);
      if (!registration) return result(command, false, undefined, 'not_found');
      const generation = registrationGenerations.get(key);
      if (!generation) return result(command, false, undefined, 'not_found');
      const registrationWithEdits = editAwareRegistration(key, registration);
      const restoreMutationValue = async (
        previousValue: unknown,
        previousUserEdit: ReturnType<
          NonNullable<ControlRegistration['getUserEditSnapshot']>
        > | null,
      ) => {
        if (
          await reconcileSupersededRegistration(key, generation, previousValue)
        ) {
          return;
        }
        await restoreRegistrationValue(
          registrationWithEdits,
          previousValue,
          previousUserEdit,
          (invoke) => invokeExtension(key, invoke),
        );
      };
      let publicCommand: ControlCommand =
        redactsValue(registration) &&
        (command.action === 'stage' || command.action === 'apply')
          ? cloneValue({ ...command, value: undefined })
          : cloneValue(command);
      const publicContext: ControlCommandContext = {
        source: context.source,
        confirmed: context.confirmed,
        localGesture: localGestureConfirmed,
        actorId: context.actorId,
        sessionId: context.sessionId,
      };
      const customPolicy = options.policy;

      try {
        let snapshot = snapshotOf(registration);
        let preparedStageValue: unknown;
        let preparedStageBaseValue: unknown;
        const commandUserEditSnapshot =
          command.action === 'apply' ||
          command.action === 'clear' ||
          command.action === 'undo'
            ? (cloneValue(registrationWithEdits.getUserEditSnapshot?.()) ??
              null)
            : null;
        let invariantDecision = defaultPolicy(
          command,
          publicContext,
          snapshot,
          publicContext.localGesture === true,
        );
        let policyDecision = invariantDecision;
        if (invariantDecision.allowed && command.action === 'stage') {
          // A control may resolve a proposal relative to its current value (for
          // example, append-mode textareas). Custom policy must inspect the
          // exact resolved value that will be staged. If a human changes the
          // control while policy awaits, retry against the new stable base.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            preparedStageBaseValue = cloneValue(registration.getValue?.());
            preparedStageValue = cloneValue(
              registration.prepareValue
                ? invokeExtension(key, () =>
                    registration.prepareValue?.(command.value),
                  )
                : command.value,
            );
            snapshot = snapshotOf(registration);
            publicCommand = redactsValue(registration)
              ? cloneValue({ ...command, value: undefined })
              : cloneValue({ ...command, value: preparedStageValue });
            policyDecision = customPolicy
              ? await invokeExtension(key, (extensionContext) =>
                  customPolicy(
                    cloneValue(publicCommand),
                    cloneValue(publicContext),
                    cloneValue(snapshot),
                    extensionContext,
                  ),
                )
              : invariantDecision;
            if (registrationGenerations.get(key) !== generation) {
              throw new Error('staged_value_stale');
            }
            invariantDecision = defaultPolicy(
              command,
              publicContext,
              snapshotOf(registration),
              publicContext.localGesture === true,
            );
            if (!invariantDecision.allowed) {
              throw new Error(invariantDecision.reason ?? 'denied');
            }
            if (
              valuesEqual(preparedStageBaseValue, registration.getValue?.())
            ) {
              break;
            }
            if (attempt === 7) throw new Error('staged_value_stale');
          }
        } else if (invariantDecision.allowed && customPolicy) {
          policyDecision = await invokeExtension(key, (extensionContext) =>
            customPolicy(
              cloneValue(publicCommand),
              cloneValue(publicContext),
              cloneValue(snapshot),
              extensionContext,
            ),
          );
        }
        if (registrationGenerations.get(key) !== generation) {
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
            await invokeExtension(key, (extensionContext) =>
              registration.validate?.(extensionContext),
            );
            break;
          case 'stage':
            stagedRevision += 1;
            {
              const revision = stagedRevision;
              const preparedValue = preparedStageValue;
              const entry: InternalStagedEntry = {
                value: cloneValue(preparedValue),
                baseValue: cloneValue(preparedStageBaseValue),
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
                const validation = await invokeExtension(
                  key,
                  (extensionContext) =>
                    validateProposedValue(
                      registration,
                      preparedValue,
                      extensionContext,
                    ),
                );
                if (
                  registrationGenerations.get(key) !== generation ||
                  staged.get(key) !== entry
                ) {
                  throw new Error('stale_revision');
                }
                const commitSnapshot: ControlSnapshot = {
                  identity: cloneValue(registration.identity),
                  metadata: {
                    ...registration.metadata,
                    capabilities: capabilitiesOf(registration),
                  },
                  state: {
                    ...registration.getState?.(),
                    valueRedacted: redactsValue(registration),
                  },
                };
                const commitInvariant = defaultPolicy(
                  command,
                  publicContext,
                  commitSnapshot,
                  publicContext.localGesture === true,
                );
                if (!commitInvariant.allowed) {
                  throw new Error(commitInvariant.reason ?? 'denied');
                }
                if (!capabilitiesOf(registration).includes('stage')) {
                  throw new Error('unsupported');
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
            const suppliedValue =
              'value' in command && command.value !== undefined;
            const usesReviewedStagedValue =
              suppliedValue &&
              stagedEntry !== undefined &&
              valuesEqual(command.value, stagedEntry.value);
            const nextValue = usesReviewedStagedValue
              ? stagedEntry.value
              : suppliedValue
                ? registration.prepareValue
                  ? invokeExtension(key, () =>
                      registration.prepareValue?.(command.value),
                    )
                  : command.value
                : stagedEntry?.value;
            if (nextValue === undefined && !stagedEntry) {
              throw new Error('no_staged_value');
            }
            const authorizedValue = cloneValue(nextValue);
            const proposedValidation = await invokeExtension(
              key,
              (extensionContext) =>
                validateProposedValue(
                  registration,
                  authorizedValue,
                  extensionContext,
                ),
            );
            if (registrationGenerations.get(key) !== generation) {
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
            try {
              await invokeTrackedValueMutation(
                key,
                registration,
                generation,
                previousValue,
                userEditSnapshot,
                (extensionContext) =>
                  setRegistrationValue(
                    registration,
                    cloneValue(authorizedValue),
                    extensionContext,
                  ),
              );
            } catch (error) {
              try {
                await restoreMutationValue(previousValue, userEditSnapshot);
              } catch {
                // Preserve the original setter failure for the command result.
              }
              throw error;
            }
            if (
              registrationGenerations.get(key) !== generation ||
              userEditSuperseded(registrationWithEdits, userEditSnapshot)
            ) {
              await restoreMutationValue(previousValue, userEditSnapshot);
              throw new Error('staged_value_stale');
            }
            const appliedValue = cloneValue(registration.getValue?.());
            if (!valuesEqual(appliedValue, authorizedValue)) {
              try {
                await restoreMutationValue(previousValue, userEditSnapshot);
              } catch {
                // Preserve the rejected apply result and retain its proposal.
              }
              throw new Error('staged_value_rejected');
            }
            try {
              const valid = await invokeExtension(key, (extensionContext) =>
                registration.validate?.(extensionContext),
              );
              if (
                registrationGenerations.get(key) !== generation ||
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
              const decision = await invokeTrackedValueMutation(
                key,
                registration,
                generation,
                previousValue,
                userEditSnapshot,
                (extensionContext) =>
                  registration.clear
                    ? registration.clear(extensionContext)
                    : setRegistrationValue(registration, '', extensionContext),
              );
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
              registrationGenerations.get(key) !== generation ||
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
            const expectedPreviousValue = cloneValue(undoEntry.previousValue);
            const userEditSnapshot = commandUserEditSnapshot;
            if (!valuesEqual(currentValue, undoEntry.appliedValue)) {
              throw new Error('staged_value_stale');
            }
            try {
              await invokeTrackedValueMutation(
                key,
                registration,
                generation,
                currentValue,
                userEditSnapshot,
                (extensionContext) =>
                  setRegistrationValue(
                    registration,
                    cloneValue(expectedPreviousValue),
                    extensionContext,
                  ),
              );
            } catch (error) {
              try {
                await restoreMutationValue(currentValue, userEditSnapshot);
              } catch {
                // Preserve the original setter failure for the command result.
              }
              throw error;
            }
            if (
              registrationGenerations.get(key) !== generation ||
              userEditSuperseded(registrationWithEdits, userEditSnapshot)
            ) {
              await restoreMutationValue(currentValue, userEditSnapshot);
              throw new Error('staged_value_stale');
            }
            if (
              !valuesEqual(registration.getValue?.(), expectedPreviousValue)
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
      const commandSnapshots = cloneCommandBatch(commands);
      if (!commandSnapshots) {
        const results = commands.map(cloneFailureResult);
        return { ok: false, results };
      }
      let contextSnapshot: ControlCommandContext;
      try {
        contextSnapshot = cloneValue(context);
      } catch {
        const results = commandSnapshots.map(cloneFailureResult);
        return { ok: false, results };
      }
      const results: ControlCommandResult[] = [];
      for (const command of commandSnapshots) {
        results.push(await this.execute(command, contextSnapshot));
      }
      return { ok: results.every((entry) => entry.ok), results };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const localGestureExecutor: LocalGestureBatchExecutor = async (
    suppliedRegistry,
    commands,
    event,
  ) => {
    const eventState = nativeEventState(event);
    const isLocalGesture =
      options.isLocalGesture ?? (() => eventState?.isTrusted);
    if (
      !eventState ||
      !isLocalGesture(event) ||
      eventState.eventPhase === 0 ||
      consumedLocalGestureEvents.has(event)
    ) {
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
    // Bind the entire already-snapshotted batch to the registration generations
    // present at gesture validation time. Earlier awaited commands must not be
    // able to authorize later commands against newly mounted replacements.
    const gestureGenerations = commands.map((command) =>
      registrationGenerations.get(identityKey(command.identity)),
    );
    const results: ControlCommandResult[] = [];
    for (const [index, command] of commands.entries()) {
      const context: ControlCommandContext = {
        source: 'user',
        confirmed: true,
      };
      localConfirmationGrants.set(context, {
        command,
        snapshot: cloneValue(command),
        generation: gestureGenerations[index],
      });
      try {
        results.push(await suppliedRegistry.execute(command, context));
      } finally {
        // Adapters may retain context references, but no authority survives the
        // terminal delegation/denial for this exact command.
        localConfirmationGrants.delete(context);
      }
    }
    return { ok: results.every((entry) => entry.ok), results };
  };
  localGestureBatchExecutors.set(registry, localGestureExecutor);
  Object.defineProperty(registry, localGestureBatchExecutor, {
    value: localGestureExecutor,
    enumerable: true,
  });

  return registry;
}
