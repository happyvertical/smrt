/**
 * The server load contract (#3727): run every widget's `load(options, ctx)`
 * inside a page's server load, with the request's context, and hand the
 * client a serializable {@link LoadedOverview} to render without any
 * client-only fetching.
 *
 * ```ts
 * // +page.server.ts
 * export const load = async (event) => {
 *   const resolved = resolveOverview(definition, await storedOverride(event), registry);
 *   return { overview: await loadOverview(resolved.document, definition, registry, ctx(event)) };
 * };
 * ```
 *
 * Svelte-free. The context carries the user's permissions and tenant
 * filters; this module never widens it.
 */
import { sanitizeOverview } from './model.js';
import type { WidgetRegistry } from './registry.js';
import type {
  LoadedOverview,
  LoadedWidget,
  LoadedWidgetErrorCode,
  OverviewDefinition,
  OverviewDocument,
} from './types.js';

export interface LoadOverviewOptions {
  /** Per-widget time budget in milliseconds (default 8000). */
  timeoutMs?: number;
  /** Largest serialized `data` a widget may return (default 262144 chars). */
  maxDataLength?: number;
  /**
   * Receives the real error of a failed load for server logs. The client only
   * ever gets a generic code.
   */
  onError?: (widget: { id: string; type: string }, error: unknown) => void;
}

/** The request-scoped context a page passes to {@link loadOverview}. */
export interface WidgetLoadInput {
  signal?: AbortSignal;
  locale?: string;
  [capability: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_DATA_LENGTH = 262_144;

class LoadTimeout extends Error {}

function runWithTimeout<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  parent: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LoadTimeout('widget load timed out'));
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => run(controller.signal)),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  });
}

function serializable(data: unknown, maxLength: number): boolean {
  if (data === undefined) return true;
  try {
    const json = JSON.stringify(data);
    return json !== undefined && json.length <= maxLength;
  } catch {
    return false;
  }
}

/**
 * Sanitize `document` against the registry and the page's confined set, then
 * run each widget's `load` in parallel. A widget that fails, times out or
 * returns non-serializable data renders as an error tile; it never fails the
 * page. Widgets without a `load` are `ready` with no data.
 */
export async function loadOverview(
  document: OverviewDocument,
  definition: OverviewDefinition,
  registry: WidgetRegistry,
  ctx: WidgetLoadInput,
  options: LoadOverviewOptions = {},
): Promise<LoadedOverview> {
  const sanitized = sanitizeOverview(document, { registry, definition });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLength = options.maxDataLength ?? DEFAULT_MAX_DATA_LENGTH;
  const widgets = await Promise.all(
    sanitized.document.widgets.map(async (widget): Promise<LoadedWidget> => {
      const def = registry.get(widget.type);
      const base: LoadedWidget = { ...widget, status: 'ready' };
      if (!def?.load) return base;
      const fail = (code: LoadedWidgetErrorCode): LoadedWidget => ({
        ...widget,
        status: 'error',
        error: { code },
      });
      try {
        const data = await runWithTimeout(
          (signal) =>
            def.load?.(widget.options, {
              ...ctx,
              overviewId: definition.id,
              signal,
            }),
          timeoutMs,
          ctx.signal,
        );
        if (!serializable(data, maxLength)) return fail('invalid_data');
        return data === undefined ? base : { ...base, data };
      } catch (error) {
        options.onError?.({ id: widget.id, type: widget.type }, error);
        return fail(error instanceof LoadTimeout ? 'timeout' : 'load_failed');
      }
    }),
  );
  return { overviewId: definition.id, widgets, issues: sanitized.issues };
}
