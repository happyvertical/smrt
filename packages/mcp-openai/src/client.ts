import type { McpAppBridge, ToolResult } from '@happyvertical/smrt-mcp-apps';
import {
  appRelativeUrl,
  displayMode,
  json,
  keys,
  type OpenAiDisplayMode,
  record,
  text,
  toolName,
} from './validation.js';

export { appRelativeUrl, OPENAI_EXTENSIONS_REVISION } from './validation.js';
export type CapabilityState = 'present' | 'absent' | 'unknown';
/** Deployment/host-observation input, not an invented MCP wire capability. */
export function capabilityState(value: unknown): CapabilityState {
  return value === 'present' || value === 'absent' ? value : 'unknown';
}
export interface OpenAiAppLink {
  pluginId: string;
  toolName: string;
  path?: string;
  marketplace?: string;
  platform: 'desktop' | 'mobile' | 'web';
}
export function createOpenAiAppLink(options: OpenAiAppLink): string {
  json(options);
  keys(record(options), [
    'pluginId',
    'toolName',
    'path',
    'marketplace',
    'platform',
  ]);
  const plugin = encodeURIComponent(text(options.pluginId, 256));
  const tool = encodeURIComponent(text(options.toolName, 128));
  const path = appRelativeUrl(options.path ?? '/');
  const marketplace =
    options.marketplace === undefined
      ? ''
      : `@${encodeURIComponent(text(options.marketplace, 128))}`;
  if (options.platform === 'web') {
    if (marketplace)
      throw new TypeError('Web links require a published ChatGPT plugin');
    return `https://chatgpt.com/plugins/${plugin}/app/${tool}?path=${encodeURIComponent(path)}`;
  }
  if (options.platform !== 'desktop' && options.platform !== 'mobile')
    throw new TypeError('Unsupported link platform');
  return `${options.platform === 'desktop' ? 'codex' : 'chatgpt'}://plugins/${plugin}${marketplace}/app/${tool}?path=${encodeURIComponent(path)}`;
}
function appUrl(value: unknown): string {
  const parsed = new URL(text(value, 2048));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new TypeError('Expected credential-free HTTPS application URL');
  return parsed.href;
}
/** No host-brand inference: absent/unverified support yields an ordinary application link. */
export function openAiNavigationLink(
  capability: unknown,
  link: OpenAiAppLink,
  fallbackUrl: string,
): string {
  const fallback = appUrl(fallbackUrl);
  return capabilityState(capability) === 'present'
    ? createOpenAiAppLink(link)
    : fallback;
}
/** Display negotiation remains portable; unknown modes and host failures retain inline UI. */
export async function requestOpenAiDisplayMode(
  bridge: McpAppBridge,
  requested: unknown,
): Promise<OpenAiDisplayMode> {
  let mode: OpenAiDisplayMode;
  try {
    mode = displayMode(requested);
  } catch {
    return 'inline';
  }
  const snapshot = bridge.snapshot;
  if (
    snapshot.state !== 'ready' ||
    !(snapshot.hostContext.availableDisplayModes ?? ['inline']).includes(mode)
  )
    return 'inline';
  try {
    return displayMode(await bridge.requestDisplayMode(mode));
  } catch {
    return 'inline';
  }
}
export function readOpenAiDeepLink(
  rawHostContext: unknown,
): string | undefined {
  json(rawHostContext);
  const context = record(rawHostContext);
  if (context['openai/deepLink'] === undefined) return undefined;
  const link = record(context['openai/deepLink']);
  keys(link, ['url']);
  return appRelativeUrl(link.url);
}
/** Observe inert host context, then request a domain-authorized read; never route to arbitrary URLs. */
export function observeOpenAiNavigation(options: {
  bridge: McpAppBridge;
  resolveTool: string;
  onResult(result: ToolResult, url: string): void;
  onFallback(reason: 'unavailable' | 'invalid' | 'denied'): void;
}): () => void {
  const name = toolName(options.resolveTool);
  let last: string | undefined;
  let generation = 0;
  let disposed = false;
  let pending: AbortController | undefined;
  const unsubscribe = options.bridge.subscribe((snapshot) => {
    if (disposed || snapshot.state !== 'ready') return;
    let url: string | undefined;
    try {
      url = readOpenAiDeepLink(snapshot.rawHostContext);
    } catch {
      last = undefined;
      generation++;
      pending?.abort();
      options.onFallback('invalid');
      return;
    }
    if (url === undefined || url === last) return;
    last = url;
    const current = ++generation;
    pending?.abort();
    if (!snapshot.hostCapabilities.serverTools) {
      options.onFallback('unavailable');
      return;
    }
    pending = new AbortController();
    void options.bridge
      .callTool(name, { url }, pending.signal)
      .then((result) => {
        if (disposed || current !== generation || options.bridge.signal.aborted)
          return;
        if (result.isError) options.onFallback('denied');
        else options.onResult(result, url);
      })
      .catch(() => {
        if (
          !disposed &&
          current === generation &&
          !options.bridge.signal.aborted
        )
          options.onFallback('denied');
      });
  });
  return () => {
    disposed = true;
    generation++;
    pending?.abort();
    unsubscribe();
  };
}
