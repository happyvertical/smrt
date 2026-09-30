import type { McpAppBridge, ToolResult } from '@happyvertical/smrt-mcp-apps';
import {
  type FileContent,
  type FileRead,
  type FileWriteResult,
  fileContent,
  fileRead,
  fileWriteResult,
  type OpenAiFileInput,
  validateFileInput,
} from './file-contracts.js';
import { json, record, text, toolName } from './validation.js';

export type {
  FileContent,
  FileRead,
  FileWriteResult,
  OpenAiFileInput,
} from './file-contracts.js';
export { validateFileInput } from './file-contracts.js';

type Extension = ReturnType<McpAppBridge['registerExtension']>;
export type FileOperation = 'read' | 'write' | 'subscribe' | 'open';
export interface OpenAiFileOptions {
  bridge: McpAppBridge;
  input: OpenAiFileInput;
  /** Existing app workflow: fresh principal/owner/tenant/grant check on every call. */
  authorityTool: string;
  /** Ordinary import/open/download workflow, used when native capability is absent. */
  fallbackTool: string;
  /** Application policy, capped below the portable bridge's JSON envelope limit. */
  maxBytes: number;
  mimeTypes: readonly string[];
}
function capability(bridge: McpAppBridge, key: string): boolean {
  try {
    const raw = record(bridge.snapshot.rawHostCapabilities.experimental);
    record(raw[key]);
    return true;
  } catch {
    return false;
  }
}
function emptyResult(result: unknown): void {
  json(result);
  const value = record(result);
  if (value.isError === true) throw new Error('Host denied file operation');
}
/** One initial tool-input grant, one lifetime; create a new session after reconnect/input change. */
export class OpenAiFileSession {
  readonly #options: OpenAiFileOptions;
  readonly #input: OpenAiFileInput;
  readonly #extension?: Extension;
  readonly #lifetime = new AbortController();
  #latest?: FileRead;
  #writing = false;
  #subscribed = false;
  #stop?: () => void;
  #generation = 0;
  #unsubscribeLifecycle: () => void;
  constructor(options: OpenAiFileOptions) {
    this.#input = validateFileInput(options.input);
    toolName(options.authorityTool);
    toolName(options.fallbackTool);
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 16384
    )
      throw new TypeError('Expected file byte bound from 1 to 16384');
    if (
      !options.mimeTypes.length ||
      options.mimeTypes.length > 16 ||
      options.mimeTypes.some((mime) => !/^[\w.+-]+\/[\w.+-]+$/.test(mime))
    )
      throw new TypeError('Expected explicit MIME allowlist');
    this.#options = { ...options, mimeTypes: [...options.mimeTypes] };
    if (options.bridge.snapshot.state !== 'ready')
      throw new Error('Bridge is not ready');
    if (capability(options.bridge, 'openai/resource')) {
      this.#extension = options.bridge.registerExtension({
        id: 'openai.files.resources',
        capability: { path: ['experimental', 'openai/resource'] },
        methods: [
          'resources/read',
          'resources/subscribe',
          'resources/unsubscribe',
          'openai/resources/write',
        ],
        notifications: ['notifications/resources/updated'],
      });
    }
    this.#unsubscribeLifecycle = options.bridge.subscribe((snapshot) => {
      if (snapshot.state === 'disposed' || snapshot.cancelled) this.dispose();
      if (snapshot.toolInput !== undefined) {
        try {
          const input = validateFileInput(snapshot.toolInput);
          if (
            input.file.resourceUri !== this.#input.file.resourceUri ||
            input.file.name !== this.#input.file.name
          )
            this.dispose();
        } catch {
          this.dispose();
        }
      }
    });
  }
  get native(): boolean {
    return Boolean(this.#extension);
  }
  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }
  #active(): void {
    if (this.signal.aborted || this.#options.bridge.signal.aborted)
      throw new Error('File session disposed');
  }
  async #authorize(operation: FileOperation): Promise<void> {
    this.#active();
    const result = await this.#options.bridge.callTool(
      this.#options.authorityTool,
      { ...this.#input, operation },
      this.signal,
    );
    this.#active();
    if (result.isError) {
      this.#latest = undefined;
      throw new Error('File authority denied');
    }
  }
  async fallback(operation: FileOperation): Promise<ToolResult> {
    await this.#authorize(operation);
    const result = await this.#options.bridge.callTool(
      this.#options.fallbackTool,
      { ...this.#input, operation },
      this.signal,
    );
    this.#active();
    if (result.isError) throw new Error('File workflow denied');
    return result;
  }
  async read(representation?: 'text' | 'blob'): Promise<FileRead | ToolResult> {
    if (
      representation !== undefined &&
      representation !== 'text' &&
      representation !== 'blob'
    )
      throw new TypeError('Invalid representation');
    if (!this.#extension) return this.fallback('read');
    const generation = ++this.#generation;
    this.#latest = undefined;
    await this.#authorize('read');
    const result = await this.#extension.request(
      'resources/read',
      {
        uri: this.#input.file.resourceUri,
        ...(representation
          ? { _meta: { 'openai/resource': { representation } } }
          : {}),
      },
      this.signal,
    );
    const file = fileRead(
      result,
      this.#input.file.resourceUri,
      this.#options.maxBytes,
      this.#options.mimeTypes,
    );
    await this.#authorize('read');
    if (generation !== this.#generation) throw new Error('Stale file read');
    this.#latest = file;
    return structuredClone(file);
  }
  async write(content: FileContent): Promise<FileWriteResult | ToolResult> {
    this.#active();
    if (!this.#extension) return this.fallback('write');
    if (this.#writing) throw new Error('File write already pending');
    const previous = this.#latest;
    if (!previous?.writable || !previous.etag)
      throw new Error('Fresh writable ETag required');
    const bounded = fileContent(content, this.#options.maxBytes);
    this.#writing = true;
    this.#latest = undefined;
    ++this.#generation;
    try {
      await this.#authorize('write');
      const result = fileWriteResult(
        await this.#extension.request(
          'openai/resources/write',
          {
            uri: this.#input.file.resourceUri,
            ifMatch: previous.etag,
            ...bounded,
          },
          this.signal,
        ),
      );
      this.#active();
      // All outcomes require a new authorized read; unknown failures are never retried.
      return result;
    } finally {
      this.#writing = false;
      this.#latest = undefined;
      ++this.#generation;
    }
  }
  async subscribe(
    onRead: (file: FileRead) => void,
    onError: (error: unknown) => void,
  ): Promise<void> {
    this.#active();
    if (!this.#extension) {
      await this.fallback('subscribe');
      return;
    }
    if (this.#subscribed) throw new Error('Already subscribed');
    this.#subscribed = true;
    let refreshing = false;
    let dirty = false;
    const refresh = async () => {
      if (refreshing) {
        dirty = true;
        return;
      }
      refreshing = true;
      try {
        do {
          dirty = false;
          const result = await this.read();
          if (!this.signal.aborted && this.#subscribed)
            onRead(result as FileRead);
        } while (dirty && !this.signal.aborted && this.#subscribed);
      } catch (error) {
        if (!this.signal.aborted) {
          try {
            onError(error);
          } finally {
            this.dispose();
          }
        }
      } finally {
        refreshing = false;
      }
    };
    try {
      await this.#authorize('subscribe');
      this.#stop = this.#extension.subscribe((method, params) => {
        if (method !== 'notifications/resources/updated' || this.signal.aborted)
          return;
        if (params.uri !== this.#input.file.resourceUri) return;
        this.#latest = undefined;
        void refresh();
      });
      emptyResult(
        await this.#extension.request(
          'resources/subscribe',
          { uri: this.#input.file.resourceUri },
          this.signal,
        ),
      );
      this.#active();
    } catch (error) {
      this.#stop?.();
      this.#stop = undefined;
      this.#subscribed = false;
      throw error;
    }
  }
  dispose(): void {
    if (this.signal.aborted) return;
    this.#latest = undefined;
    ++this.#generation;
    this.#stop?.();
    this.#unsubscribeLifecycle?.();
    if (
      this.#subscribed &&
      this.#extension &&
      !this.#options.bridge.signal.aborted
    ) {
      // Host cleanup is best effort. Local authority and callbacks end immediately.
      void this.#extension
        .request('resources/unsubscribe', { uri: this.#input.file.resourceUri })
        .catch(() => {})
        .finally(() => this.#extension?.dispose());
    } else this.#extension?.dispose();
    this.#subscribed = false;
    this.#lifetime.abort();
  }
}

/** User action calls this after the existing provider selects and authorizes an exact path. */
export async function openOpenAiFile(options: {
  bridge: McpAppBridge;
  resolveTool: string;
  arguments: Record<string, unknown>;
  allowedPaths: readonly string[];
  /** Explicit application confirmation UI; false cancels without resolving or opening. */
  confirm(): Promise<boolean>;
}): Promise<ToolResult | undefined> {
  if (!(await options.confirm())) return;
  const result = await options.bridge.callTool(
    toolName(options.resolveTool),
    options.arguments,
  );
  if (result.isError) throw new Error('File opening denied');
  if (!capability(options.bridge, 'openai/files')) return result;
  const path = text(record(result.structuredContent).path, 2048);
  if (
    !options.allowedPaths.includes(path) ||
    !/^(\/[^/]|[A-Za-z]:\\)/.test(path) ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    path.split(/[\\/]/).some((part) => part === '.' || part === '..')
  )
    throw new TypeError('File opening path denied');
  const extension = options.bridge.registerExtension({
    id: 'openai.files.open',
    capability: { path: ['experimental', 'openai/files'] },
    methods: ['openai/files/open'],
    notifications: [],
  });
  try {
    emptyResult(await extension.request('openai/files/open', { path }));
  } finally {
    extension.dispose();
  }
}
