/**
 * Transport-neutral interaction model for addressable form controls.
 *
 * The registry deliberately knows nothing about chat, agents, WebMCP, or the
 * DOM. Controls register serializable metadata plus small imperative handles;
 * adapters translate voice/chat/tutorial requests into commands.
 */

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
  setValue?: (value: unknown) => void | Promise<void>;
  clear?: () => void | Promise<void>;
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
  list(formId?: string): ControlSnapshot[];
  get(identity: ControlIdentity): ControlSnapshot | undefined;
  execute(
    command: ControlCommand,
    context?: ControlCommandContext,
  ): Promise<ControlCommandResult>;
  /** Executes in order and always returns an explicit result for every command. */
  executeBatch(
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

type LocalGestureExecutor = (
  command: ControlCommand,
  event: Event,
) => Promise<ControlCommandResult>;

const localGestureExecutors = new WeakMap<
  ControlInteractionRegistry,
  LocalGestureExecutor
>();

/** @internal Called only by the framework's local DOM event handlers. */
export function executeLocalControlCommand(
  registry: ControlInteractionRegistry,
  command: ControlCommand,
  event: Event,
): Promise<ControlCommandResult> {
  const executor = localGestureExecutors.get(registry);
  if (!executor) {
    return Promise.resolve({
      ok: false,
      action: command.action,
      identity: { ...command.identity },
      reason: 'local_gesture_required',
    });
  }
  return executor(command, event);
}

/** @internal Ordered best-effort execution from one trusted local gesture. */
export async function executeLocalControlBatch(
  registry: ControlInteractionRegistry,
  commands: ControlCommand[],
  event: Event,
): Promise<ControlBatchResult> {
  const results: ControlCommandResult[] = [];
  for (const command of commands) {
    results.push(await executeLocalControlCommand(registry, command, event));
  }
  return { ok: results.every((result) => result.ok), results };
}

function identityKey(identity: ControlIdentity): string {
  const subject = identity.subject
    ? `${identity.subject.type}:${identity.subject.id}`
    : '';
  return `${identity.formId}\u0000${identity.controlId}\u0000${subject}`;
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
  if (snapshot.metadata.sensitivity === 'secret') {
    return { allowed: false, reason: 'sensitive_control' };
  }
  if (snapshot.metadata.writable === false) {
    return { allowed: false, reason: 'control_not_writable' };
  }
  if (snapshot.state.disabled || snapshot.state.readonly) {
    return { allowed: false, reason: 'control_not_editable' };
  }
  if (context.source === 'agent' && command.action !== 'stage') {
    return { allowed: false, reason: 'human_confirmation_required' };
  }
  if (
    (command.action === 'apply' || command.action === 'discard') &&
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

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
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
  const undo = new Map<string, unknown[]>();
  const listeners = new Set<(event: ControlInteractionEvent) => void>();
  const now = options.now ?? Date.now;
  const locallyConfirmedContexts = new WeakSet<ControlCommandContext>();
  let stagedRevision = 0;

  const emit = (event: Omit<ControlInteractionEvent, 'timestamp'>) => {
    const next = { ...event, timestamp: now() };
    for (const listener of listeners) listener(next);
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
    return {
      identity: { ...registration.identity },
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
        value: redacted ? undefined : registration.getValue?.(),
        valueRedacted: redacted,
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
  ): ControlCommandResult => ({
    ok,
    action: command.action,
    identity: { ...command.identity },
    snapshot: registration ? snapshotOf(registration) : undefined,
    reason,
  });

  const registry: ControlInteractionRegistry = {
    register(registration) {
      const key = identityKey(registration.identity);
      registrations.set(key, registration);
      emit({ type: 'registered', identity: registration.identity });
      return () => {
        if (registrations.get(key) !== registration) return;
        registrations.delete(key);
        staged.delete(key);
        undo.delete(key);
        emit({ type: 'unregistered', identity: registration.identity });
      };
    },

    unregister(identity) {
      const key = identityKey(identity);
      if (!registrations.delete(key)) return;
      staged.delete(key);
      undo.delete(key);
      emit({ type: 'unregistered', identity });
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
      const registration = registrations.get(key);
      if (!registration) return result(command, false, undefined, 'not_found');
      const publicCommand: ControlCommand =
        redactsValue(registration) &&
        (command.action === 'stage' || command.action === 'apply')
          ? { ...command, value: undefined }
          : command;
      const publicContext: ControlCommandContext = {
        source: context.source,
        confirmed: context.confirmed,
        localGesture: locallyConfirmedContexts.has(context),
        actorId: context.actorId,
        sessionId: context.sessionId,
      };

      const snapshot = snapshotOf(registration);
      const invariantDecision = defaultPolicy(
        command,
        publicContext,
        snapshot,
        publicContext.localGesture === true,
      );
      const policyDecision =
        invariantDecision.allowed && options.policy
          ? await options.policy(publicCommand, publicContext, snapshot)
          : invariantDecision;
      if (!policyDecision.allowed) {
        const denied = result(
          command,
          false,
          registration,
          policyDecision.reason ?? 'denied',
        );
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
        const unsupported = result(command, false, registration, 'unsupported');
        emit({
          type: 'command',
          identity: command.identity,
          command: publicCommand,
          context: publicContext,
          result: unsupported,
        });
        return unsupported;
      }

      try {
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
            staged.set(key, {
              value: cloneValue(command.value),
              baseValue: cloneValue(registration.getValue?.()),
              provenance: {
                source: context.source,
                actorId: context.actorId,
                sessionId: context.sessionId,
              },
              stagedAt: now(),
              revision: stagedRevision,
              ...(await validateProposedValue(registration, command.value)),
            });
            emit({
              type: 'staged',
              identity: command.identity,
              command: publicCommand,
              context: publicContext,
              staged: snapshotOf(registration).state.staged,
            });
            break;
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
            if (proposedValidation.valid === false) {
              if (stagedEntry) Object.assign(stagedEntry, proposedValidation);
              throw new Error(
                redactsValue(registration)
                  ? 'staged_value_invalid'
                  : (proposedValidation.validationMessage ??
                      'staged_value_invalid'),
              );
            }
            const previousValue = cloneValue(registration.getValue?.());
            const history = undo.get(key) ?? [];
            await registration.setValue?.(nextValue);
            const valid = await registration.validate?.();
            if (valid === false) {
              await registration.setValue?.(previousValue);
              if (stagedEntry) {
                stagedEntry.valid = false;
                stagedEntry.validationMessage =
                  registration.getState?.().validationMessage ??
                  'staged_value_invalid';
              }
              throw new Error('staged_value_invalid');
            }
            history.push(previousValue);
            undo.set(key, history);
            staged.delete(key);
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
            const history = undo.get(key) ?? [];
            history.push(registration.getValue?.());
            undo.set(key, history);
            if (registration.clear) await registration.clear();
            else await registration.setValue?.('');
            staged.delete(key);
            break;
          }
          case 'undo': {
            const history = undo.get(key) ?? [];
            if (history.length === 0) throw new Error('nothing_to_undo');
            await registration.setValue?.(history.pop());
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
        const failed = result(
          command,
          false,
          registration,
          error instanceof Error ? error.message : 'command_failed',
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

  localGestureExecutors.set(registry, async (command, event) => {
    const isLocalGesture =
      options.isLocalGesture ?? ((candidate: Event) => candidate.isTrusted);
    if (!isLocalGesture(event)) {
      const registration = registrations.get(identityKey(command.identity));
      return result(command, false, registration, 'local_gesture_required');
    }
    const context: ControlCommandContext = {
      source: 'user',
      confirmed: true,
    };
    locallyConfirmedContexts.add(context);
    return registry.execute(command, context);
  });

  return registry;
}
