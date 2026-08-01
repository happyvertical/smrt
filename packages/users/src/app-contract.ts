/**
 * Versioned discovery and cross-transport contracts for SMRT application
 * surfaces.
 *
 * The artifact is intentionally data-only: downstream apps may persist its
 * canonical JSON and pin the SHA-256 digest without parsing CLI help text or
 * depending on a particular transport implementation.
 *
 * @packageDocumentation
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  CliResource,
  CommandDefinition,
  ResourceListResponseBody,
} from './sveltekit/resource-list-handler.js';

/** Immutable selector for this discovery artifact family. */
export const SMRT_DISCOVERY_CONFORMANCE_SCHEMA =
  'https://smrt.dev/schemas/discovery-conformance/v1';
/** Version of the discovery artifact payload. */
export const SMRT_DISCOVERY_CONFORMANCE_VERSION = 1 as const;
/** Versioned selector for structured application results and errors. */
export const SMRT_APP_RESULT_SCHEMA = 'https://smrt.dev/schemas/app-result/v1';
/** Version of the structured application result contract. */
export const SMRT_APP_RESULT_VERSION = 1 as const;
/** MCP result `_meta` member carrying the app-result metadata. */
export const SMRT_MCP_RESULT_METADATA_KEY = 'io.happyvertical/smrt';

/** JSON-safe value used by structured details and parameter schemas. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A declared input field which controls retry or optimistic-concurrency use. */
export interface DeclaredActionField {
  /** JSON Schema property name supplied by the action. */
  field: string;
  /** Whether the action marks the field required. */
  required: boolean;
}

/** Retry and concurrency declarations projected from a command schema. */
export interface CommandRequirements {
  idempotencyKey?: DeclaredActionField;
  expectedVersion?: DeclaredActionField;
}

/** Machine-readable metadata shared by HTTP CLI and MCP bridge results. */
export interface AppResultMetadata {
  code: string;
  message?: string;
  details?: JsonValue;
  retryable?: boolean;
  correlationId?: string;
  idempotencyKey?: DeclaredActionField;
  expectedVersion?: DeclaredActionField;
}

export interface AppResultContract {
  schema: typeof SMRT_APP_RESULT_SCHEMA;
  version: typeof SMRT_APP_RESULT_VERSION;
  mcpMetadataKey: typeof SMRT_MCP_RESULT_METADATA_KEY;
  metadataFields: readonly [
    'code',
    'message',
    'details',
    'retryable',
    'correlationId',
    'idempotencyKey',
    'expectedVersion',
  ];
}

/** Stable description of the result metadata contract contained in an artifact. */
export const SMRT_APP_RESULT_CONTRACT: AppResultContract = {
  schema: SMRT_APP_RESULT_SCHEMA,
  version: SMRT_APP_RESULT_VERSION,
  mcpMetadataKey: SMRT_MCP_RESULT_METADATA_KEY,
  metadataFields: [
    'code',
    'message',
    'details',
    'retryable',
    'correlationId',
    'idempotencyKey',
    'expectedVersion',
  ],
};

/** The pre-artifact wire payload, kept for the existing `/_resources` fields. */
export type DiscoveryPayload = Omit<ResourceListResponseBody, 'artifact'>;

export interface DiscoveryArtifactIntegrity {
  algorithm: 'sha256';
  /** `sha256:<lowercase-hex>` over canonical unsigned artifact JSON. */
  digest: string;
}

/** Versioned payload a consumer can validate and pin. */
export interface DiscoveryConformanceArtifact {
  schema: typeof SMRT_DISCOVERY_CONFORMANCE_SCHEMA;
  version: typeof SMRT_DISCOVERY_CONFORMANCE_VERSION;
  discovery: DiscoveryPayload;
  resultContract: AppResultContract;
  integrity: DiscoveryArtifactIntegrity;
}

/** A JSON Schema export for consumers that validate artifacts outside Node. */
export const SMRT_DISCOVERY_CONFORMANCE_ARTIFACT_SCHEMA = {
  $id: SMRT_DISCOVERY_CONFORMANCE_SCHEMA,
  type: 'object',
  required: ['schema', 'version', 'discovery', 'resultContract', 'integrity'],
  properties: {
    schema: { const: SMRT_DISCOVERY_CONFORMANCE_SCHEMA },
    version: { const: SMRT_DISCOVERY_CONFORMANCE_VERSION },
    discovery: {
      type: 'object',
      required: ['user', 'warnings', 'resources'],
      properties: {
        user: { type: 'object', required: ['authenticated'] },
        warnings: { type: 'array', items: { type: 'string' } },
        resources: { type: 'array' },
      },
    },
    resultContract: {
      type: 'object',
      required: ['schema', 'version', 'mcpMetadataKey', 'metadataFields'],
    },
    integrity: {
      type: 'object',
      required: ['algorithm', 'digest'],
      properties: {
        algorithm: { const: 'sha256' },
        digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      },
    },
  },
} as const;

/** Thrown when an artifact is malformed, non-canonical, or fails its digest. */
export class DiscoveryArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryArtifactValidationError';
  }
}

/**
 * Project conventionally named request fields from a JSON Schema into the
 * discovery contract. This is declarative only: the action remains the owner
 * of enforcement and may use a body field or adapt it to an HTTP header.
 */
export function deriveCommandRequirements(
  parameters: Record<string, unknown> | undefined,
): CommandRequirements | undefined {
  const properties = isRecord(parameters?.properties)
    ? parameters.properties
    : undefined;
  if (!properties) return undefined;

  const required = new Set(
    Array.isArray(parameters?.required)
      ? parameters.required.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  const findField = (
    names: readonly string[],
  ): DeclaredActionField | undefined => {
    const field = names.find((name) => Object.hasOwn(properties, name));
    return field ? { field, required: required.has(field) } : undefined;
  };

  const requirements: CommandRequirements = {
    idempotencyKey: findField(['idempotencyKey', 'idempotency_key']),
    expectedVersion: findField(['expectedVersion', 'expected_version']),
  };
  return requirements.idempotencyKey || requirements.expectedVersion
    ? requirements
    : undefined;
}

/** Produce a deterministically ordered artifact with a SHA-256 integrity pin. */
export function createDiscoveryConformanceArtifact(
  discovery: DiscoveryPayload,
): DiscoveryConformanceArtifact {
  const normalizedDiscovery = normalizeDiscovery(discovery);
  const unsigned = {
    schema: SMRT_DISCOVERY_CONFORMANCE_SCHEMA,
    version: SMRT_DISCOVERY_CONFORMANCE_VERSION,
    discovery: normalizedDiscovery,
    resultContract: SMRT_APP_RESULT_CONTRACT,
  } as const;

  return {
    ...unsigned,
    integrity: {
      algorithm: 'sha256',
      digest: digestUnsignedArtifact(unsigned),
    },
  };
}

/**
 * Validate structure, canonical ordering, and the integrity digest. Returns
 * the typed artifact so consumers can use one operation for validation and
 * consumption.
 */
export function validateDiscoveryConformanceArtifact(
  value: unknown,
): DiscoveryConformanceArtifact {
  if (!isRecord(value)) fail('artifact must be an object');
  if (value.schema !== SMRT_DISCOVERY_CONFORMANCE_SCHEMA) {
    fail(`unsupported artifact schema: ${String(value.schema)}`);
  }
  if (value.version !== SMRT_DISCOVERY_CONFORMANCE_VERSION) {
    fail(`unsupported artifact version: ${String(value.version)}`);
  }
  if (!isRecord(value.integrity) || value.integrity.algorithm !== 'sha256') {
    fail('artifact integrity.algorithm must be sha256');
  }
  if (
    typeof value.integrity.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.integrity.digest)
  ) {
    fail('artifact integrity.digest must be lowercase sha256 hex');
  }
  validateResultContract(value.resultContract);
  const discovery = validateDiscovery(value.discovery);
  const artifact: DiscoveryConformanceArtifact = {
    schema: SMRT_DISCOVERY_CONFORMANCE_SCHEMA,
    version: SMRT_DISCOVERY_CONFORMANCE_VERSION,
    discovery,
    resultContract: SMRT_APP_RESULT_CONTRACT,
    integrity: {
      algorithm: 'sha256',
      digest: value.integrity.digest,
    },
  };
  const expected = digestUnsignedArtifact({
    schema: artifact.schema,
    version: artifact.version,
    discovery: artifact.discovery,
    resultContract: artifact.resultContract,
  });
  if (!safeDigestEqual(expected, artifact.integrity.digest)) {
    fail('artifact integrity digest does not match canonical payload');
  }
  return artifact;
}

/** Canonical JSON bytes whose digest is carried by the artifact. */
export function canonicalizeDiscoveryArtifact(
  artifact: Omit<DiscoveryConformanceArtifact, 'integrity'>,
): string {
  return canonicalJson(artifact);
}

function normalizeDiscovery(discovery: DiscoveryPayload): DiscoveryPayload {
  const resources = [...discovery.resources]
    .map(normalizeResource)
    .sort((left, right) => compareText(left.slug, right.slug));
  return {
    user: discovery.user.id
      ? { authenticated: discovery.user.authenticated, id: discovery.user.id }
      : { authenticated: discovery.user.authenticated },
    warnings: [...discovery.warnings].sort(compareText),
    resources,
  };
}

function normalizeResource(resource: CliResource): CliResource {
  const commands = [...resource.commands]
    .map(normalizeCommand)
    .sort((left, right) => compareText(left.commandName, right.commandName));
  return {
    slug: resource.slug,
    className: resource.className,
    ...(resource.qualifiedName
      ? { qualifiedName: resource.qualifiedName }
      : {}),
    ...(resource.packageName ? { packageName: resource.packageName } : {}),
    label: resource.label,
    apiPath: resource.apiPath,
    commands,
  };
}

function normalizeCommand(command: CommandDefinition): CommandDefinition {
  return {
    methodName: command.methodName,
    commandName: command.commandName,
    kind: command.kind,
    scope: command.scope,
    httpMethod: command.httpMethod,
    pathSegments: [...command.pathSegments],
    ...(command.description ? { description: command.description } : {}),
    ...(command.parameters
      ? {
          parameters: canonicalJsonValue(command.parameters) as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(command.requirements ? { requirements: command.requirements } : {}),
  };
}

function validateDiscovery(value: unknown): DiscoveryPayload {
  if (!isRecord(value)) fail('artifact discovery must be an object');
  if (!isRecord(value.user) || typeof value.user.authenticated !== 'boolean') {
    fail('artifact discovery.user.authenticated must be boolean');
  }
  if (value.user.id !== undefined && typeof value.user.id !== 'string') {
    fail('artifact discovery.user.id must be a string');
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every(isString)) {
    fail('artifact discovery.warnings must be a string array');
  }
  assertSorted(value.warnings, 'artifact discovery.warnings');
  if (!Array.isArray(value.resources)) {
    fail('artifact discovery.resources must be an array');
  }
  const resources = value.resources.map(validateResource);
  assertSorted(
    resources.map((resource) => resource.slug),
    'artifact discovery.resources',
  );
  return {
    user: value.user.id
      ? { authenticated: value.user.authenticated, id: value.user.id }
      : { authenticated: value.user.authenticated },
    warnings: [...value.warnings],
    resources,
  };
}

function validateResource(value: unknown): CliResource {
  if (!isRecord(value)) fail('artifact resource must be an object');
  const slug = requireArtifactString(value.slug, 'resource.slug');
  const className = requireArtifactString(
    value.className,
    'resource.className',
  );
  const label = requireArtifactString(value.label, 'resource.label');
  const apiPath = requireArtifactString(value.apiPath, 'resource.apiPath');
  if (!Array.isArray(value.commands))
    fail('artifact resource.commands must be an array');
  const commands = value.commands.map(validateCommand);
  assertSorted(
    commands.map((command) => command.commandName),
    'artifact resource.commands',
  );
  return {
    slug,
    className,
    ...(typeof value.qualifiedName === 'string'
      ? { qualifiedName: value.qualifiedName }
      : {}),
    ...(typeof value.packageName === 'string'
      ? { packageName: value.packageName }
      : {}),
    label,
    apiPath,
    commands,
  };
}

function validateCommand(value: unknown): CommandDefinition {
  if (!isRecord(value)) fail('artifact command must be an object');
  const methodName = requireArtifactString(
    value.methodName,
    'command.methodName',
  );
  const commandName = requireArtifactString(
    value.commandName,
    'command.commandName',
  );
  const httpMethod = requireArtifactString(
    value.httpMethod,
    'command.httpMethod',
  );
  if (value.kind !== 'crud' && value.kind !== 'custom') {
    fail('artifact command.kind must be crud or custom');
  }
  if (value.scope !== 'item' && value.scope !== 'collection') {
    fail('artifact command.scope must be item or collection');
  }
  if (
    !Array.isArray(value.pathSegments) ||
    !value.pathSegments.every(isString)
  ) {
    fail('artifact command.pathSegments must be a string array');
  }
  if (value.parameters !== undefined && !isRecord(value.parameters)) {
    fail('artifact command.parameters must be an object');
  }
  const requirements = validateRequirements(value.requirements);
  return {
    methodName,
    commandName,
    kind: value.kind,
    scope: value.scope,
    httpMethod: httpMethod as CommandDefinition['httpMethod'],
    pathSegments: [...value.pathSegments],
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    ...(value.parameters
      ? {
          parameters: canonicalJsonValue(value.parameters) as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(requirements ? { requirements } : {}),
  };
}

function validateRequirements(value: unknown): CommandRequirements | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('artifact command.requirements must be an object');
  const parseField = (
    candidate: unknown,
    name: string,
  ): DeclaredActionField | undefined => {
    if (candidate === undefined) return undefined;
    if (
      !isRecord(candidate) ||
      typeof candidate.field !== 'string' ||
      candidate.field === '' ||
      typeof candidate.required !== 'boolean'
    ) {
      fail(`artifact command.requirements.${name} is invalid`);
    }
    return { field: candidate.field, required: candidate.required };
  };
  const requirements: CommandRequirements = {
    idempotencyKey: parseField(value.idempotencyKey, 'idempotencyKey'),
    expectedVersion: parseField(value.expectedVersion, 'expectedVersion'),
  };
  return requirements.idempotencyKey || requirements.expectedVersion
    ? requirements
    : undefined;
}

function validateResultContract(value: unknown): void {
  if (!isRecord(value)) fail('artifact resultContract must be an object');
  if (
    value.schema !== SMRT_APP_RESULT_SCHEMA ||
    value.version !== SMRT_APP_RESULT_VERSION ||
    value.mcpMetadataKey !== SMRT_MCP_RESULT_METADATA_KEY ||
    !Array.isArray(value.metadataFields) ||
    canonicalJson(value.metadataFields) !==
      canonicalJson(SMRT_APP_RESULT_CONTRACT.metadataFields)
  ) {
    fail('artifact resultContract does not match SMRT app-result v1');
  }
}

function digestUnsignedArtifact(
  artifact: Omit<DiscoveryConformanceArtifact, 'integrity'>,
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalizeDiscoveryArtifact(artifact), 'utf8')
    .digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      fail('artifact cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (isRecord(value)) {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      normalized[key] = canonicalJsonValue(value[key]);
    }
    return normalized;
  }
  fail(`artifact contains unsupported value type: ${typeof value}`);
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function assertSorted(values: readonly string[], name: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareText(previous, current) > 0
    ) {
      fail(`${name} must be deterministically sorted`);
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function requireArtifactString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    fail(`artifact ${name} must be a non-empty string`);
  }
  return value;
}

function fail(message: string): never {
  throw new DiscoveryArtifactValidationError(message);
}
