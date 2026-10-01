/** Bounded JSON only. Never stringify arbitrary incoming objects before checking depth. */
export function json(value: unknown): void {
  let budget = 131072;
  const visit = (v: unknown, depth: number): void => {
    if (--budget < 0 || depth > 24)
      throw new Error('MCP Apps payload exceeds limits');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string') {
      budget -= v.length * 3;
      if (budget < 0) throw new Error('MCP Apps payload exceeds limits');
      return;
    }
    if (Array.isArray(v)) {
      const length = Object.getOwnPropertyDescriptor(v, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 4096)
        throw new Error('MCP Apps array exceeds limits');
      // Structured clone preserves named array properties. JSON does not: reject
      // them (including symbol iterators), holes and accessors before any reads.
      if (Reflect.ownKeys(v).length !== length + 1)
        throw new Error('Expected dense JSON array');
      const values: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(index));
        if (!descriptor || !('value' in descriptor))
          throw new Error('Expected JSON array data property');
        values.push(descriptor.value);
      }
      for (let index = 0; index < length; index++)
        visit(values[index], depth + 1);
      return;
    }
    if (!record(v)) throw new Error('Expected JSON object');
    const keys = Object.keys(v);
    if (keys.length > 1024) throw new Error('MCP Apps object exceeds limits');
    for (const key of keys) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('Unsafe JSON key');
      budget -= key.length * 3;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor))
        throw new Error('Expected JSON property');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}
export function record(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null)
  );
}
export function object(v: unknown): Record<string, unknown> {
  if (!record(v)) throw new Error('Expected object');
  return v;
}
export function string(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || v.length > max)
    throw new Error('Expected bounded string');
  return v;
}
export function boolean(v: unknown): void {
  if (typeof v !== 'boolean') throw new Error('Expected boolean');
}
export function id(v: unknown): v is string | number {
  return (
    (typeof v === 'string' && v.length > 0 && v.length <= 128) ||
    (typeof v === 'number' && Number.isSafeInteger(v))
  );
}
export type DisplayMode = 'inline' | 'fullscreen' | 'pip';
export function mode(v: unknown): DisplayMode {
  if (v !== 'inline' && v !== 'fullscreen' && v !== 'pip')
    throw new Error('Unsupported display mode');
  return v;
}
export interface TextContent {
  type: 'text';
  text: string;
}
export interface ToolResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** This bridge intentionally supports text + structured data, not binary content. */
export function toolResult(v: unknown): ToolResult {
  const r = object(v);
  if (!Array.isArray(r.content) || r.content.length > 128)
    throw new Error('Invalid tool content');
  const content = r.content.map((item) => {
    const block = object(item);
    if (block.type !== 'text')
      throw new Error('Unsupported tool content modality');
    return { type: 'text' as const, text: string(block.text, 32768) };
  });
  if (r.isError !== undefined) boolean(r.isError);
  return {
    content,
    ...(r.structuredContent === undefined
      ? {}
      : { structuredContent: object(r.structuredContent) }),
    ...(r.isError === undefined ? {} : { isError: r.isError as boolean }),
  };
}
export interface HostCapabilities {
  openLinks?: Record<string, never>;
  serverTools?: { listChanged?: boolean };
  message?: { text?: Record<string, never> };
  updateModelContext?: {
    text?: Record<string, never>;
    structuredContent?: Record<string, never>;
  };
}
/** Unknown capabilities never grant behavior; known malformed fields fail closed. */
export function capabilities(v: unknown): HostCapabilities {
  const input = object(v);
  const out: HostCapabilities = {};
  if (input.openLinks !== undefined) {
    object(input.openLinks);
    out.openLinks = {};
  }
  if (input.serverTools !== undefined) {
    const tools = object(input.serverTools);
    if (tools.listChanged !== undefined) boolean(tools.listChanged);
    out.serverTools =
      tools.listChanged === undefined
        ? {}
        : { listChanged: tools.listChanged as boolean };
  }
  for (const key of ['message', 'updateModelContext'] as const) {
    if (input[key] === undefined) continue;
    const modalities = object(input[key]);
    const value: {
      text?: Record<string, never>;
      structuredContent?: Record<string, never>;
    } = {};
    for (const modality of ['text', 'structuredContent'] as const) {
      if (modalities[modality] !== undefined) {
        object(modalities[modality]);
        value[modality] = {};
      }
    }
    out[key] = value;
  }
  return out;
}
/** Deliberately non-executable subset: host CSS, tool definitions and unknown keys are not applied. */
export interface HostContext {
  theme?: 'light' | 'dark';
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  platform?: 'web' | 'desktop' | 'mobile';
  locale?: string;
  timeZone?: string;
}
export function context(v: unknown): HostContext {
  const input = object(v);
  const out: HostContext = {};
  if (input.theme !== undefined) {
    if (input.theme !== 'light' && input.theme !== 'dark')
      throw new Error('Unsupported theme');
    out.theme = input.theme;
  }
  if (input.displayMode !== undefined)
    out.displayMode = mode(input.displayMode);
  if (input.availableDisplayModes !== undefined) {
    if (
      !Array.isArray(input.availableDisplayModes) ||
      input.availableDisplayModes.length > 3
    )
      throw new Error('Invalid modes');
    out.availableDisplayModes = input.availableDisplayModes.map(mode);
  }
  if (input.platform !== undefined) {
    if (!['web', 'desktop', 'mobile'].includes(string(input.platform)))
      throw new Error('Unsupported platform');
    out.platform = input.platform as HostContext['platform'];
  }
  for (const key of ['locale', 'timeZone'] as const)
    if (input[key] !== undefined) out[key] = string(input[key], 128);
  return out;
}
export function success(v: unknown): void {
  const r = object(v);
  if (r.isError !== undefined) boolean(r.isError);
  if (r.isError === true) throw new Error('Host rejected request');
}
