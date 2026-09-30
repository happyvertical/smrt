import { json, object, string } from './validation.js';

/** Trusted local declaration. Extension adapters own method-specific wire schemas. */
export interface McpAppExtensionDefinition {
  id: string;
  capability: {
    /** Own-property path into the initialized host's capability object. */
    path: readonly string[];
    /** Only declare this when the extension's wire capability actually has a version field. */
    version?: { key: string; supported: readonly string[] };
  };
  methods: readonly string[];
  notifications: readonly string[];
}
/** One owner, one initialized bridge lifetime; no independent transport or authority. */
export interface McpAppExtension {
  readonly signal: AbortSignal;
  request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  subscribe(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  dispose(): void;
}
export interface RegisteredExtension {
  definition: McpAppExtensionDefinition;
  lifetime: AbortController;
  listeners: Set<(method: string, params: Record<string, unknown>) => void>;
}
function name(value: unknown): string {
  const result = string(value, 128);
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]*(\/[a-zA-Z][a-zA-Z0-9_.-]*){1,4}$/.test(result))
    throw new Error('Invalid extension method name');
  return result;
}
/** Validate and copy the declaration before it can affect transport dispatch. */
export function extensionDefinition(
  value: McpAppExtensionDefinition,
  capabilities: Record<string, unknown>,
): McpAppExtensionDefinition {
  json(value);
  const input = object(value);
  const extensionId = string(input.id, 64);
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(extensionId))
    throw new Error('Invalid extension id');
  const capability = object(input.capability);
  if (
    !Array.isArray(capability.path) ||
    capability.path.length < 1 ||
    capability.path.length > 4
  )
    throw new Error('Invalid extension capability path');
  let selected: unknown = capabilities;
  for (const key of capability.path) {
    string(key, 128);
    const parent = object(selected);
    if (!Object.hasOwn(parent, key))
      throw new Error('Host extension capability unavailable');
    selected = parent[key];
  }
  const supportedCapability = object(selected);
  if (capability.version !== undefined) {
    const version = object(capability.version);
    const key = string(version.key, 128);
    if (
      !Array.isArray(version.supported) ||
      !version.supported.length ||
      version.supported.length > 8
    )
      throw new Error('Invalid extension versions');
    for (const item of version.supported) string(item, 64);
    if (
      !Object.hasOwn(supportedCapability, key) ||
      !version.supported.includes(supportedCapability[key])
    )
      throw new Error('Unsupported host extension version');
  }
  for (const field of ['methods', 'notifications'] as const) {
    const names = input[field];
    if (
      !Array.isArray(names) ||
      names.length > 16 ||
      new Set(names).size !== names.length
    )
      throw new Error('Invalid extension allowlist');
    for (const item of names) {
      const method = name(item);
      const nativeTextRequest =
        field === 'methods' &&
        ['ui/message', 'ui/update-model-context'].includes(method);
      if (
        (method.startsWith('ui/') && !nativeTextRequest) ||
        method.startsWith('tools/') ||
        method === 'notifications/cancelled' ||
        (field === 'methods' && method.startsWith('notifications/'))
      )
        throw new Error('Reserved bridge method');
    }
  }
  return structuredClone(value);
}
