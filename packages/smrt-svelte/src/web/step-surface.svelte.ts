/**
 * `useStepSurface` — mount a wizard or other multi-step flow on the nearest
 * `<Provider webmcp>` data-surface registry, so an agent can read where the
 * person is and move the flow with `next` / `back` / `go-to`. A step whose
 * forward button saves or creates something (`nextWrites`) is never pressed
 * by an agent: `next` calls `showNext` (reveal + highlight the button) and
 * the person presses it. See `registerStepSurface` in
 * `@happyvertical/smrt-ui/data`.
 *
 * Handlers are read at command time, so pass the page's own functions — the
 * ones its buttons call. A no-op without a WebMCP Provider. Call during
 * component init.
 */
import {
  type DataSurfaceRegistry,
  registerStepSurface,
  type StepSurfaceHandle,
  type StepSurfaceOptions,
} from '@happyvertical/smrt-ui/data';
import { onDestroy } from 'svelte';
import { tryGetWebMcpUiContext } from './webmcp-ui-context.js';

export type UseStepSurfaceOptions = Omit<StepSurfaceOptions, 'registry'>;

export function useStepSurface(
  getOptions: () => UseStepSurfaceOptions | null,
  registry?: DataSurfaceRegistry,
): void {
  const uiContext = tryGetWebMcpUiContext();
  let handle: StepSurfaceHandle | null = null;
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
    const key = JSON.stringify([options.surfaceId, options.subject ?? null]);
    if (key !== mountedKey || resolved !== mountedRegistry) {
      teardown();
      handle = registerStepSurface({ ...options, registry: resolved });
      mountedKey = key;
      mountedRegistry = resolved;
      return;
    }
    handle?.update({
      steps: options.steps,
      current: options.current,
      next: options.next,
      nextWrites: options.nextWrites ?? false,
      showNext: options.showNext,
      back: options.back,
      goTo: options.goTo,
      state: options.state,
    });
  });

  onDestroy(teardown);
}
