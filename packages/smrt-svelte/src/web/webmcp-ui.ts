import {
  DATA_SURFACE_IDENTIFIER_MAX_LENGTH,
  DATA_SURFACE_MAX_REQUEST_BYTES,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  type DataSurfaceRegistry,
  type DataSurfaceSnapshot,
  type DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import type {
  ControlCommand,
  ControlCommandAction,
  ControlIdentity,
  ControlInteractionRegistry,
  ControlSnapshot,
} from '@happyvertical/smrt-ui/forms';
import type { WebMcpToolSpec } from './webmcp.svelte.js';

const CONTROL_ACTIONS = new Set<ControlCommandAction>([
  'focus',
  'reveal',
  'highlight',
  'explain',
  'validate',
  'stage',
  'apply',
  'clear',
  'undo',
]);
const DEFAULT_PREFIX = 'smrt_ui_';
const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PUBLIC_FAILURE_REASONS = new Set([
  'invalid_request',
  'invalid_identifier',
  'limit_exceeded',
  'not_found',
]);
const PUBLIC_CONTROL_RESULT_REASONS = new Set([
  'not_found',
  'consent_required',
  'sensitive_control',
  'control_not_writable',
  'control_not_editable',
  'nothing_to_undo',
  'denied',
]);
const documentLocks = new WeakMap<object, Set<string>>();

class PublicToolError extends Error {
  constructor(
    readonly reason: string,
    readonly details?: string,
  ) {
    super(reason);
  }
}

function publicError(reason: string, details?: string): PublicToolError {
  return new PublicToolError(reason, details);
}

export interface RegisterWebMcpUiToolsOptions {
  controlRegistry: ControlInteractionRegistry;
  dataSurfaceRegistry: DataSurfaceRegistry;
  prefix?: string;
  /** Injectable browser document used by tests and non-window hosts. */
  document?: { modelContext?: WebMcpModelContext };
}

type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; details?: string };

function success(result: unknown): string {
  return JSON.stringify({ ok: true, result } satisfies ToolResult);
}

function failure(reason: string, details?: string): string {
  return JSON.stringify({
    ok: false,
    reason,
    ...(details ? { details } : {}),
  } satisfies ToolResult);
}

function requestBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertRequestSize(value: unknown): void {
  if (requestBytes(value) > DATA_SURFACE_MAX_REQUEST_BYTES) {
    throw publicError('limit_exceeded');
  }
}

function requiredIdentifier(
  value: unknown,
  name: string,
  maxLength = DATA_SURFACE_IDENTIFIER_MAX_LENGTH,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw publicError('invalid_identifier', name);
  }
  return value;
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredIdentifier(value, name);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw publicError('invalid_request');
  }
  return value as Record<string, unknown>;
}

function controlIdentity(value: unknown): ControlIdentity {
  const input = record(value);
  const subjectInput = input.subject;
  const subject =
    subjectInput === undefined
      ? undefined
      : (() => {
          const next = record(subjectInput);
          return {
            type: requiredIdentifier(next.type, 'subject.type'),
            id: requiredIdentifier(next.id, 'subject.id'),
            ...(next.label === undefined
              ? {}
              : { label: requiredIdentifier(next.label, 'subject.label') }),
          };
        })();
  return {
    formId: requiredIdentifier(input.formId, 'formId'),
    controlId: requiredIdentifier(input.controlId, 'controlId'),
    ...(subject ? { subject } : {}),
  };
}

function dataSurfaceIdentity(value: unknown): DataSurfaceIdentity {
  const input = record(value);
  const kind = input.kind;
  if (!['table', 'list', 'report', 'custom'].includes(String(kind))) {
    throw publicError('invalid_request', 'identity.kind');
  }
  const subjectInput = input.subject;
  const subject =
    subjectInput === undefined
      ? undefined
      : (() => {
          const next = record(subjectInput);
          return {
            type: requiredIdentifier(next.type, 'subject.type'),
            id: requiredIdentifier(next.id, 'subject.id'),
            ...(next.label === undefined
              ? {}
              : { label: requiredIdentifier(next.label, 'subject.label') }),
          };
        })();
  return {
    surfaceId: requiredIdentifier(input.surfaceId, 'surfaceId'),
    kind: kind as DataSurfaceIdentity['kind'],
    ...(subject ? { subject } : {}),
  };
}

function sanitizeControl(snapshot: ControlSnapshot): ControlSnapshot {
  const redactText =
    snapshot.metadata.sensitivity === 'secret' || snapshot.state.valueRedacted;
  const runtimeState = { ...snapshot.state };
  delete runtimeState.validationMessage;
  return {
    ...snapshot,
    identity: { ...snapshot.identity },
    metadata: {
      ...snapshot.metadata,
      constraints: snapshot.metadata.constraints
        ? { ...snapshot.metadata.constraints }
        : undefined,
      options: snapshot.metadata.options?.map((option) => ({ ...option })),
    },
    state: {
      ...(redactText ? runtimeState : snapshot.state),
      ...(redactText || snapshot.state.valueRedacted
        ? { value: undefined }
        : {}),
      ...(redactText || snapshot.state.stagedValueRedacted
        ? { stagedValue: undefined }
        : {}),
    },
  };
}

function sanitizeSurfaceValue(
  value: unknown,
  hiddenColumnIds: Set<string>,
  redactRowIds: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(
        (entry) => typeof entry !== 'string' || !hiddenColumnIds.has(entry),
      )
      .map((entry) =>
        sanitizeSurfaceValue(entry, hiddenColumnIds, redactRowIds),
      )
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (
    typeof object.columnId === 'string' &&
    hiddenColumnIds.has(object.columnId)
  ) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(object).flatMap(([key, entry]) => {
      if (hiddenColumnIds.has(key)) return [];
      if (
        redactRowIds &&
        (key === 'selection' ||
          key === 'selectedRowIds' ||
          key === 'expandedRowIds')
      ) {
        return [];
      }
      const sanitized = sanitizeSurfaceValue(
        entry,
        hiddenColumnIds,
        redactRowIds,
      );
      return sanitized === undefined ? [] : [[key, sanitized]];
    }),
  );
}

type VisibleDataSurfaceDescriptor = Omit<DataSurfaceDescriptor, 'rowKey'> & {
  rowKey?: string;
};

type VisibleDataSurfaceSnapshot = Omit<DataSurfaceSnapshot, 'descriptor'> & {
  descriptor: VisibleDataSurfaceDescriptor;
};

function visibleDescriptor(
  descriptor: DataSurfaceDescriptor,
): VisibleDataSurfaceDescriptor {
  const columns = descriptor.columns.filter(
    (column) => column.visibility !== 'hidden',
  );
  const visibleColumnIds = new Set(columns.map((column) => column.id));
  const { rowKey, ...visible } = descriptor;
  return {
    ...visible,
    identity: { ...descriptor.identity },
    ...(visibleColumnIds.has(rowKey) ? { rowKey } : {}),
    columns,
    query: {
      ...descriptor.query,
      projectableColumnIds: descriptor.query.projectableColumnIds.filter((id) =>
        visibleColumnIds.has(id),
      ),
      searchableColumnIds: descriptor.query.searchableColumnIds?.filter((id) =>
        visibleColumnIds.has(id),
      ),
      filterableColumnIds: descriptor.query.filterableColumnIds?.filter((id) =>
        visibleColumnIds.has(id),
      ),
      sortableColumnIds: descriptor.query.sortableColumnIds?.filter((id) =>
        visibleColumnIds.has(id),
      ),
    },
    actions: descriptor.actions.filter((action) =>
      (action.columnIds ?? []).every((id) => visibleColumnIds.has(id)),
    ),
  };
}

function visibleSnapshot(
  snapshot: DataSurfaceSnapshot,
): VisibleDataSurfaceSnapshot {
  const hiddenColumnIds = new Set(
    snapshot.descriptor.columns
      .filter((column) => column.visibility === 'hidden')
      .map((column) => column.id),
  );
  const rowKeyHidden = hiddenColumnIds.has(snapshot.descriptor.rowKey);
  const state = sanitizeSurfaceValue(
    snapshot.state,
    hiddenColumnIds,
    rowKeyHidden,
  ) as DataSurfaceSnapshot['state'];
  return {
    ...snapshot,
    descriptor: visibleDescriptor(snapshot.descriptor),
    state,
    selection: rowKeyHidden ? null : snapshot.selection,
  };
}

function executeSafely(
  execute: () => unknown | Promise<unknown>,
): Promise<string> {
  return Promise.resolve()
    .then(execute)
    .then(success)
    .catch((error: unknown) => {
      return error instanceof PublicToolError &&
        PUBLIC_FAILURE_REASONS.has(error.reason)
        ? failure(error.reason, error.details)
        : failure('execution_failed');
    });
}

function readTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  execute: WebMcpToolSpec['execute'],
): WebMcpToolSpec {
  return {
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute,
  };
}

function tools(
  prefix: string,
  controlRegistry: ControlInteractionRegistry,
  dataSurfaceRegistry: DataSurfaceRegistry,
): WebMcpToolSpec[] {
  const identitySchema = {
    type: 'object',
    required: ['formId', 'controlId'],
    additionalProperties: false,
    properties: {
      formId: { type: 'string', minLength: 1, maxLength: 256 },
      controlId: { type: 'string', minLength: 1, maxLength: 256 },
      subject: { type: 'object' },
    },
  };
  const surfaceIdentitySchema = {
    type: 'object',
    required: ['surfaceId', 'kind'],
    additionalProperties: false,
    properties: {
      surfaceId: { type: 'string', minLength: 1, maxLength: 256 },
      kind: { type: 'string', enum: ['table', 'list', 'report', 'custom'] },
      subject: { type: 'object' },
    },
  };

  return [
    readTool(
      `${prefix}list_form_controls`,
      'List the controls currently mounted in SMRT forms.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          formId: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
      (args) =>
        executeSafely(() => {
          assertRequestSize(args);
          const input = record(args);
          const formId = optionalIdentifier(input.formId, 'formId');
          return controlRegistry.list(formId).map(sanitizeControl);
        }),
    ),
    readTool(
      `${prefix}inspect_form_control`,
      'Inspect one currently mounted SMRT form control.',
      {
        type: 'object',
        required: ['identity'],
        additionalProperties: false,
        properties: { identity: identitySchema },
      },
      (args) =>
        executeSafely(() => {
          assertRequestSize(args);
          const input = record(args);
          const snapshot = controlRegistry.get(controlIdentity(input.identity));
          if (!snapshot) throw publicError('not_found');
          return sanitizeControl(snapshot);
        }),
    ),
    {
      name: `${prefix}execute_form_control`,
      description:
        'Execute an allowed command on a mounted SMRT form control. Agent mutations are consent-gated.',
      inputSchema: {
        type: 'object',
        required: ['action', 'identity'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...CONTROL_ACTIONS] },
          identity: identitySchema,
          value: {},
          durationMs: { type: 'number', minimum: 0, maximum: 60_000 },
        },
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: (args) =>
        executeSafely(async () => {
          assertRequestSize(args);
          const input = record(args);
          if ('confirmed' in input)
            throw publicError('invalid_request', 'confirmed');
          if (!CONTROL_ACTIONS.has(input.action as ControlCommandAction)) {
            throw publicError('invalid_request', 'action');
          }
          const action = input.action as ControlCommandAction;
          const identity = controlIdentity(input.identity);
          let command: ControlCommand;
          if (action === 'stage') {
            if (!('value' in input))
              throw publicError('invalid_request', 'value');
            command = { action, identity, value: input.value };
          } else if (action === 'apply') {
            command =
              'value' in input
                ? { action, identity, value: input.value }
                : { action, identity };
          } else if (action === 'highlight') {
            if (
              input.durationMs !== undefined &&
              (typeof input.durationMs !== 'number' ||
                input.durationMs < 0 ||
                input.durationMs > 60_000)
            ) {
              throw publicError('invalid_request', 'durationMs');
            }
            command = { action, identity, durationMs: input.durationMs };
          } else {
            command = { action, identity } as ControlCommand;
          }
          const result = await controlRegistry.execute(command, {
            source: 'agent',
          });
          const reason = result.reason
            ? PUBLIC_CONTROL_RESULT_REASONS.has(result.reason)
              ? result.reason
              : 'execution_failed'
            : undefined;
          return {
            ...result,
            ...(reason ? { reason } : { reason: undefined }),
            ...(result.snapshot
              ? { snapshot: sanitizeControl(result.snapshot) }
              : {}),
          };
        }),
    },
    readTool(
      `${prefix}list_data_surfaces`,
      'List the data surfaces currently mounted in this SMRT Provider.',
      { type: 'object', additionalProperties: false, properties: {} },
      (args) =>
        executeSafely(() => {
          assertRequestSize(args);
          record(args);
          return dataSurfaceRegistry.list().map(visibleDescriptor);
        }),
    ),
    readTool(
      `${prefix}inspect_data_surface`,
      'Inspect one currently mounted SMRT data surface.',
      {
        type: 'object',
        required: ['identity'],
        additionalProperties: false,
        properties: { identity: surfaceIdentitySchema },
      },
      (args) =>
        executeSafely(() => {
          assertRequestSize(args);
          const input = record(args);
          const snapshot = dataSurfaceRegistry.inspect(
            dataSurfaceIdentity(input.identity),
          );
          if (!snapshot) throw publicError('not_found');
          return visibleSnapshot(snapshot);
        }),
    ),
    {
      name: `${prefix}execute_data_surface_control`,
      description:
        'Execute a bounded visible-state command on a mounted SMRT data surface.',
      inputSchema: {
        type: 'object',
        required: [
          'version',
          'commandId',
          'identity',
          'expectedRevision',
          'controlId',
        ],
        additionalProperties: false,
        properties: {
          version: { type: 'number', const: 1 },
          commandId: { type: 'string', minLength: 1, maxLength: 256 },
          identity: surfaceIdentitySchema,
          expectedRevision: { type: 'number', minimum: 0 },
          controlId: { type: 'string', minLength: 1, maxLength: 256 },
          payload: {},
        },
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: (args) =>
        executeSafely(async () => {
          assertRequestSize(args);
          const input = record(args);
          if (input.version !== 1)
            throw publicError('invalid_request', 'version');
          if (
            typeof input.expectedRevision !== 'number' ||
            !Number.isSafeInteger(input.expectedRevision) ||
            input.expectedRevision < 0
          ) {
            throw publicError('invalid_request', 'expectedRevision');
          }
          const command: DataSurfaceVisibleCommand = {
            version: 1,
            commandId: requiredIdentifier(input.commandId, 'commandId'),
            identity: dataSurfaceIdentity(input.identity),
            expectedRevision: input.expectedRevision,
            controlId: requiredIdentifier(input.controlId, 'controlId'),
            ...('payload' in input ? { payload: input.payload as never } : {}),
          };
          const result = await dataSurfaceRegistry.execute(command);
          return result.snapshot
            ? { ...result, snapshot: visibleSnapshot(result.snapshot) }
            : result;
        }),
    },
  ];
}

/** Register the fixed browser-native adapter over mounted UI registries. */
export function registerWebMcpUiTools(
  options: RegisterWebMcpUiToolsOptions,
): () => void {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError('Invalid WebMCP UI tool prefix');
  }

  const documentLike =
    options.document ??
    (globalThis as { document?: { modelContext?: WebMcpModelContext } })
      .document;
  const modelContext = documentLike?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    return () => {};
  }

  let locks = documentLocks.get(documentLike);
  if (!locks) {
    locks = new Set();
    documentLocks.set(documentLike, locks);
  }
  if (locks.has(prefix)) {
    throw new Error(`WebMCP UI prefix is already registered: ${prefix}`);
  }
  locks.add(prefix);

  const controller = new AbortController();
  let disposed = false;
  try {
    for (const tool of tools(
      prefix,
      options.controlRegistry,
      options.dataSurfaceRegistry,
    )) {
      modelContext.registerTool(tool, { signal: controller.signal });
    }
  } catch (error) {
    controller.abort();
    locks.delete(prefix);
    throw error;
  }

  return () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    locks.delete(prefix);
  };
}
