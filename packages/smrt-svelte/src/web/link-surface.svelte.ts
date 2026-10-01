/**
 * `useLinkSurface` — mount a navigation list (a menu, a tab row, a section
 * list) on the nearest `<Provider webmcp>` data-surface registry for the
 * calling component's lifetime, so an agent can move the person between
 * pages. See `registerLinkSurface` in `@happyvertical/smrt-ui/data`.
 *
 * Re-mounts when the identity (surface id + kind + subject) changes and
 * publishes link/state changes as new revisions. A no-op without a WebMCP
 * Provider (nothing could dispatch to it). Call during component init.
 */
import {
  type DataSurfaceRegistry,
  type LinkSurfaceHandle,
  type LinkSurfaceOptions,
  registerLinkSurface,
} from '@happyvertical/smrt-ui/data';
import { onDestroy } from 'svelte';
import { tryGetWebMcpUiContext } from './webmcp-ui-context.js';

export type UseLinkSurfaceOptions = Omit<LinkSurfaceOptions, 'registry'>;

export function useLinkSurface(
  getOptions: () => UseLinkSurfaceOptions | null,
  registry?: DataSurfaceRegistry,
): void {
  const uiContext = tryGetWebMcpUiContext();
  let handle: LinkSurfaceHandle | null = null;
  let mountedKey: string | null = null;
  let mountedRegistry: DataSurfaceRegistry | null = null;

  const teardown = () => {
    handle?.destroy();
    handle = null;
    mountedKey = null;
    mountedRegistry = null;
  };

  $effect(() => {
    const options = getOptions();
    const resolved =
      registry ??
      (uiContext?.enabled ? uiContext.dataSurfaceRegistry : undefined);
    if (!resolved || !options) {
      teardown();
      return;
    }
    const key = JSON.stringify([
      options.surfaceId,
      options.kind ?? 'list',
      options.subject ?? null,
      (options.controls ?? []).map((control) => control.id),
    ]);
    if (key !== mountedKey || resolved !== mountedRegistry) {
      teardown();
      handle = registerLinkSurface({ ...options, registry: resolved });
      mountedKey = key;
      mountedRegistry = resolved;
      return;
    }
    handle?.update({ links: options.links, state: options.state });
  });

  onDestroy(teardown);
}
