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

export interface ControlSnapshot {
  identity: ControlIdentity;
  metadata: ControlMetadata;
  state: ControlRuntimeState & {
    value?: unknown;
    valueRedacted: boolean;
    stagedValue?: unknown;
    stagedValueRedacted?: boolean;
  };
}

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
  | 'clear'
  | 'undo';

export type ControlCommand =
  | {
      action: 'focus' | 'reveal' | 'explain' | 'validate' | 'undo';
      identity: ControlIdentity;
    }
  | { action: 'highlight'; identity: ControlIdentity; durationMs?: number }
  | { action: 'stage'; identity: ControlIdentity; value: unknown }
  | { action: 'apply'; identity: ControlIdentity; value?: unknown }
  | { action: 'clear'; identity: ControlIdentity };

export type ControlCommandSource =
  | 'user'
  | 'voice'
  | 'agent'
  | 'tutorial'
  | 'test';

export interface ControlCommandContext {
  source: ControlCommandSource;
  /** Agent mutations require this explicit consent signal by default. */
  confirmed?: boolean;
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

export interface ControlInteractionEvent {
  type: 'registered' | 'unregistered' | 'staged' | 'command';
  identity: ControlIdentity;
  command?: ControlCommand;
  context?: ControlCommandContext;
  result?: ControlCommandResult;
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
  subscribe(listener: (event: ControlInteractionEvent) => void): () => void;
}

export interface CreateControlInteractionRegistryOptions {
  policy?: ControlInteractionPolicy;
}

function identityKey(identity: ControlIdentity): string {
  const subject = identity.subject
    ? `${identity.subject.type}:${identity.subject.id}`
    : '';
  return `${identity.formId}\u0000${identity.controlId}\u0000${subject}`;
}

function isMutation(action: ControlCommandAction): boolean {
  return ['stage', 'apply', 'clear', 'undo'].includes(action);
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
      capabilities.push('stage', 'apply', 'undo');
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
  return isSecret(registration) || registration.metadata.readable === false;
}

function defaultPolicy(
  command: ControlCommand,
  context: ControlCommandContext,
  snapshot: ControlSnapshot,
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
  if (
    context.source === 'agent' &&
    command.action !== 'stage' &&
    !context.confirmed
  ) {
    return { allowed: false, reason: 'consent_required' };
  }
  return { allowed: true };
}

/** Create an isolated registry; apps choose where and how it is exposed. */
export function createControlInteractionRegistry(
  options: CreateControlInteractionRegistryOptions = {},
): ControlInteractionRegistry {
  const registrations = new Map<string, ControlRegistration>();
  const staged = new Map<string, unknown>();
  const undo = new Map<string, unknown[]>();
  const listeners = new Set<(event: ControlInteractionEvent) => void>();

  const emit = (event: Omit<ControlInteractionEvent, 'timestamp'>) => {
    const next = { ...event, timestamp: Date.now() };
    for (const listener of listeners) listener(next);
  };

  const snapshotOf = (registration: ControlRegistration): ControlSnapshot => {
    const key = identityKey(registration.identity);
    const redacted = redactsValue(registration);
    const hasStaged = staged.has(key);
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
        ...registration.getState?.(),
        value: redacted ? undefined : registration.getValue?.(),
        valueRedacted: redacted,
        stagedValue: hasStaged && !redacted ? staged.get(key) : undefined,
        stagedValueRedacted: hasStaged ? redacted : undefined,
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

  return {
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

      const snapshot = snapshotOf(registration);
      const policyDecision = await (options.policy ?? defaultPolicy)(
        command,
        context,
        snapshot,
      );
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
          command,
          context,
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
          command,
          context,
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
            staged.set(key, command.value);
            emit({
              type: 'staged',
              identity: command.identity,
              command,
              context,
            });
            break;
          case 'apply': {
            const nextValue =
              'value' in command && command.value !== undefined
                ? command.value
                : staged.get(key);
            if (nextValue === undefined && !staged.has(key)) {
              throw new Error('no_staged_value');
            }
            const history = undo.get(key) ?? [];
            history.push(registration.getValue?.());
            undo.set(key, history);
            await registration.setValue?.(nextValue);
            staged.delete(key);
            await registration.validate?.();
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
          command,
          context,
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
          command,
          context,
          result: failed,
        });
        return failed;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
