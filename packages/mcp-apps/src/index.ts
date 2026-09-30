import type {
  DisplayMode,
  HostCapabilities,
  HostContext,
  ToolResult,
} from './validation.js';
import {
  capabilities,
  context,
  id,
  json,
  mode,
  object,
  string,
  success,
  toolResult,
} from './validation.js';

export type {
  DisplayMode,
  HostCapabilities,
  HostContext,
  TextContent,
  ToolResult,
} from './validation.js';

/** Pinned independently from the server MCP protocol (2026-07-28). */
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
/** Exact upstream schema baseline, not a dependency on the SDK v1 helper. */
export const MCP_APPS_SCHEMA_REVISION =
  '82221c0c8ce7661efa6771c9d461511b1650495f';
export interface McpAppBridgeOptions {
  /** The immediate parent (including a sandbox proxy), supplied by trusted app configuration. */
  hostWindow: Window;
  /** Exact parent origin. Opaque/null/wildcard origins are intentionally unsupported. */
  hostOrigin: string;
  appInfo: { name: string; version: string };
  window?: Window;
  timeoutMs?: number;
  availableDisplayModes?: DisplayMode[];
}
export interface McpAppSnapshot {
  state: 'idle' | 'connecting' | 'ready' | 'disposed';
  hostCapabilities: HostCapabilities;
  hostContext: HostContext;
  /** Bounded JSON from the bound host, isolated on every snapshot. Extensions must validate their own fields. */
  rawHostContext: Readonly<Record<string, unknown>>;
  /** Informational extension negotiation only; never bypasses the bridge's typed capability gates. */
  rawHostCapabilities: Readonly<Record<string, unknown>>;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
  cancelled?: boolean;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
/** Portable view-side transport. It never registers browser closures as remote tools. */
export class McpAppBridge {
  readonly #host: Window;
  readonly #window: Window;
  readonly #origin: string;
  readonly #timeout: number;
  readonly #appInfo: { name: string; version: string };
  readonly #modes: DisplayMode[];
  readonly #prefix: string;
  readonly #pending = new Map<string, Pending>();
  readonly #subscribers = new Set<(snapshot: McpAppSnapshot) => void>();
  readonly #lifetime = new AbortController();
  #sequence = 0;
  #inputReceived = false;
  #terminalReceived = false;
  #connect?: Promise<void>;
  #snapshot: McpAppSnapshot = {
    state: 'idle',
    hostCapabilities: {},
    hostContext: {},
    rawHostContext: {},
    rawHostCapabilities: {},
  };

  constructor(options: McpAppBridgeOptions) {
    const origin = new URL(options.hostOrigin);
    if (
      origin.origin !== options.hostOrigin ||
      !['https:', 'http:'].includes(origin.protocol)
    )
      throw new Error('Expected exact HTTP(S) host origin');
    if (
      origin.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    )
      throw new Error('Host origin requires HTTPS');
    this.#window = options.window ?? window;
    this.#host = options.hostWindow;
    if (this.#host === this.#window)
      throw new Error('MCP Apps requires an embedded host window');
    this.#origin = options.hostOrigin;
    this.#timeout = options.timeoutMs ?? 15000;
    if (
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 120000
    )
      throw new Error('Invalid request timeout');
    this.#appInfo = {
      name: string(options.appInfo.name, 128),
      version: string(options.appInfo.version, 128),
    };
    this.#modes = (options.availableDisplayModes ?? ['inline']).map(mode);
    if (!this.#modes.length || this.#modes.length > 3)
      throw new Error('Invalid app display modes');
    this.#prefix = this.#window.crypto.randomUUID();
  }

  /** Aborts component-owned asynchronous work on host teardown or local disposal. */
  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }
  get snapshot(): McpAppSnapshot {
    return structuredClone(this.#snapshot);
  }
  subscribe(listener: (snapshot: McpAppSnapshot) => void): () => void {
    if (this.#snapshot.state === 'disposed') return () => {};
    this.#subscribers.add(listener);
    listener(this.snapshot);
    return () => {
      this.#subscribers.delete(listener);
    };
  }
  #emit(): void {
    for (const listener of this.#subscribers) {
      // One component observer cannot prevent transport cleanup or other observers.
      try {
        listener(this.snapshot);
      } catch {
        /* Observer owns its error reporting. */
      }
    }
  }
  #post(message: Record<string, unknown>): void {
    json(message);
    this.#host.postMessage(message, this.#origin);
  }
  #request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#snapshot.state === 'disposed' || signal?.aborted)
      return Promise.reject(new Error('MCP Apps request cancelled'));
    if (this.#pending.size >= 32)
      return Promise.reject(new Error('Too many pending MCP Apps requests'));
    const requestId = `${this.#prefix}:${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.cleanup();
        reject(new Error('MCP Apps request cancelled or timed out'));
        try {
          this.#post({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId },
          });
        } catch {
          /* Local cancellation remains effective. */
        }
      };
      const timer = setTimeout(cancel, this.#timeout);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      };
      this.#pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.#post({ jsonrpc: '2.0', id: requestId, method, params });
      } catch (error) {
        this.#pending.delete(requestId);
        cleanup();
        reject(error);
      }
    });
  }
  /** Negotiate once. Failed or timed-out negotiation closes this instance permanently. */
  connect(): Promise<void> {
    if (this.#connect) return this.#connect;
    if (this.#snapshot.state === 'disposed')
      return Promise.reject(new Error('MCP Apps bridge disposed'));
    this.#snapshot.state = 'connecting';
    this.#window.addEventListener('message', this.#receive);
    this.#emit();
    this.#connect = this.#request('ui/initialize', {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      appInfo: this.#appInfo,
      appCapabilities: { availableDisplayModes: this.#modes },
    })
      .then((value) => {
        if (this.#snapshot.state === 'disposed')
          throw new Error('MCP Apps bridge disposed');
        const result = object(value);
        if (result.protocolVersion !== MCP_APPS_PROTOCOL_VERSION)
          throw new Error('Unsupported MCP Apps protocol version');
        const info = object(result.hostInfo);
        string(info.name, 128);
        string(info.version, 128);
        this.#snapshot.hostCapabilities = capabilities(result.hostCapabilities);
        this.#snapshot.hostContext = context(result.hostContext);
        this.#snapshot.rawHostContext = structuredClone(
          object(result.hostContext),
        );
        this.#snapshot.rawHostCapabilities = structuredClone(
          object(result.hostCapabilities),
        );
        this.#post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
        this.#snapshot.state = 'ready';
        this.#emit();
      })
      .catch((error) => {
        this.dispose();
        throw error;
      });
    return this.#connect;
  }
  #ready(): void {
    if (this.#snapshot.state !== 'ready')
      throw new Error('MCP Apps bridge is not ready');
  }
  #require(capability: keyof HostCapabilities): void {
    this.#ready();
    if (!this.#snapshot.hostCapabilities[capability])
      throw new Error(`Host capability unavailable: ${capability}`);
  }
  /** Calls the server through the host. No credentials, tenant overrides or approval metadata. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    this.#require('serverTools');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name))
      throw new Error('Invalid tool name');
    object(args);
    return toolResult(
      await this.#request('tools/call', { name, arguments: args }, signal),
    );
  }
  /** Human review destination only; applications own their approved URL allowlist. */
  async openLink(url: string, signal?: AbortSignal): Promise<void> {
    this.#require('openLinks');
    const parsed = new URL(string(url));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('Expected credential-free HTTPS link');
    success(await this.#request('ui/open-link', { url: parsed.href }, signal));
  }
  async sendMessage(text: string, signal?: AbortSignal): Promise<void> {
    this.#require('message');
    if (!this.#snapshot.hostCapabilities.message?.text)
      throw new Error('Host text modality unavailable');
    success(
      await this.#request(
        'ui/message',
        {
          role: 'user',
          content: [{ type: 'text', text: string(text, 16384) }],
        },
        signal,
      ),
    );
  }
  async updateModelContext(
    value: { text?: string; structuredContent?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<void> {
    this.#require('updateModelContext');
    const caps = this.#snapshot.hostCapabilities.updateModelContext;
    const params: Record<string, unknown> = {};
    if (value.text !== undefined) {
      if (!caps?.text) throw new Error('Host text modality unavailable');
      params.content = [{ type: 'text', text: string(value.text, 16384) }];
    }
    if (value.structuredContent !== undefined) {
      if (!caps?.structuredContent)
        throw new Error('Host structured modality unavailable');
      params.structuredContent = object(value.structuredContent);
    }
    success(await this.#request('ui/update-model-context', params, signal));
  }
  async requestDisplayMode(
    value: DisplayMode,
    signal?: AbortSignal,
  ): Promise<DisplayMode> {
    this.#ready();
    const requested = mode(value);
    if (
      !this.#modes.includes(requested) ||
      !(
        this.#snapshot.hostContext.availableDisplayModes ?? ['inline']
      ).includes(requested)
    )
      throw new Error('Display mode unavailable');
    return mode(
      object(
        await this.#request(
          'ui/request-display-mode',
          { mode: requested },
          signal,
        ),
      ).mode,
    );
  }
  reportSize(width: number, height: number): void {
    this.#ready();
    if (
      ![width, height].every((v) => Number.isFinite(v) && v >= 0 && v <= 100000)
    )
      throw new Error('Invalid view dimensions');
    this.#post({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width, height },
    });
  }
  readonly #receive = (event: MessageEvent): void => {
    if (
      event.source !== this.#host ||
      event.origin !== this.#origin ||
      this.#snapshot.state === 'disposed'
    )
      return;
    try {
      json(event.data);
      const message = object(event.data);
      if (message.jsonrpc !== '2.0') return;
      if (typeof message.method === 'string') {
        if (
          'result' in message ||
          'error' in message ||
          this.#snapshot.state !== 'ready'
        )
          return;
        this.#incoming(message);
        return;
      }
      if (
        !id(message.id) ||
        typeof message.id !== 'string' ||
        'result' in message === 'error' in message
      )
        return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      let error: Error | undefined;
      if ('error' in message) {
        const failure = object(message.error);
        if (!Number.isSafeInteger(failure.code)) return;
        error = new Error(
          `Host error ${failure.code}: ${string(failure.message, 4096)}`,
        );
      }
      this.#pending.delete(message.id);
      pending.cleanup();
      if (error) pending.reject(error);
      else pending.resolve(message.result);
    } catch {
      /* Malformed/untrusted messages cannot change lifecycle or settle a request. */
    }
  };
  #incoming(message: Record<string, unknown>): void {
    if ('id' in message) {
      if (!id(message.id)) return;
      if (
        message.method === 'ping' ||
        message.method === 'ui/resource-teardown'
      ) {
        if (message.params !== undefined) object(message.params);
        try {
          this.#post({ jsonrpc: '2.0', id: message.id, result: {} });
        } finally {
          if (message.method === 'ui/resource-teardown') this.dispose();
        }
      } else {
        this.#post({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      return;
    }
    const params = object(message.params);
    switch (message.method) {
      case 'ui/notifications/host-context-changed': {
        const projected = context(params);
        const merged = { ...this.#snapshot.rawHostContext, ...params };
        // Each notification is bounded, and accumulated extension state must be too.
        json(merged);
        this.#snapshot.hostContext = {
          ...this.#snapshot.hostContext,
          ...projected,
        };
        this.#snapshot.rawHostContext = structuredClone(merged);
        break;
      }
      case 'ui/notifications/tool-input':
        if (this.#inputReceived || this.#terminalReceived) return;
        this.#snapshot.toolInput =
          params.arguments === undefined ? {} : object(params.arguments);
        this.#inputReceived = true;
        break;
      case 'ui/notifications/tool-result':
        if (!this.#inputReceived || this.#terminalReceived) return;
        this.#snapshot.toolResult = toolResult(params);
        this.#terminalReceived = true;
        break;
      case 'ui/notifications/tool-cancelled':
        if (this.#terminalReceived) return;
        if (params.reason !== undefined) string(params.reason);
        this.#snapshot.cancelled = true;
        this.#terminalReceived = true;
        break;
      default:
        return;
    }
    this.#emit();
  }
  /** Idempotent. Pending requests reject; late responses and notifications have no owner. */
  dispose(): void {
    if (this.#snapshot.state === 'disposed') return;
    this.#snapshot.state = 'disposed';
    this.#window.removeEventListener('message', this.#receive);
    this.#lifetime.abort();
    for (const [requestId, pending] of this.#pending) {
      pending.cleanup();
      pending.reject(new Error('MCP Apps bridge disposed'));
      try {
        this.#post({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId },
        });
      } catch {
        /* Best effort transport cancellation. */
      }
    }
    this.#pending.clear();
    this.#emit();
    this.#subscribers.clear();
  }
}
