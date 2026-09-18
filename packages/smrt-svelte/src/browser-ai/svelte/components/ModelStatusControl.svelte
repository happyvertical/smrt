<script lang="ts">
/**
 * Model status control
 *
 * Presents ONE inference backend's model lifecycle to a user: whether it is
 * loaded, a way to load or release it, and live download progress. Driven
 * entirely by the backend's own `status`/`progress`/`subscribe` surface, so it
 * works anywhere — a shell dock, a settings panel, or a workbench that has no
 * `<Provider>` ancestor. When a `<Provider ai>` IS configured, pass the local
 * backend built from the app-state-managed adapter and this control reflects
 * the same warm-cached model the rest of the app uses.
 *
 * An `unavailable` backend is a first-class state, not an error: a device
 * without WebGPU is expected to fall through to the route backend, and the
 * message says so rather than offering a Load button that cannot succeed.
 */
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  InferenceBackend,
  InferenceBackendStatus,
  InferenceProgress,
} from '@happyvertical/smrt-web/ai';
import DownloadProgress from './DownloadProgress.svelte';

export interface Props {
  /** The backend whose model lifecycle this control presents. */
  backend: InferenceBackend;
  /** Human label for the model, e.g. "On-device model". */
  label?: string;
  /** Offer a release action once the model is ready. */
  allowUnload?: boolean;
  /** Extra class(es) for layout in a host. */
  class?: string;
  /** Called when a load or unload rejects (also rendered inline). */
  onerror?: (error: Error) => void;
}

let {
  backend,
  label = 'Local model',
  allowUnload = true,
  class: className = '',
  onerror,
}: Props = $props();

const STATUS_LABEL: Record<InferenceBackendStatus, string> = {
  unavailable: 'Not available on this device',
  idle: 'Not loaded',
  loading: 'Loading…',
  ready: 'Ready',
  error: 'Load failed',
};

let busy = $state(false);
let failure = $state<string | null>(null);

// `backend.status`/`backend.progress` are plain properties, so nothing tells
// this component when they change. `revision` is the subscription's pulse: the
// derived re-reads the LIVE backend properties each time it ticks, which keeps
// the initial render correct (no effect needed for it) and follows a `backend`
// prop swap, since reading the prop inside the derived is itself reactive.
let revision = $state(0);
const snapshot = $derived.by(() => {
  void revision;
  return { status: backend.status, progress: backend.progress };
});

$effect(() => {
  const current = backend;
  // No bump here: the derived reads `backend` itself, so a prop swap already
  // re-derives. Bumping from the effect body would read AND write `revision`,
  // which Svelte treats as an update loop.
  return current.subscribe?.(() => {
    revision += 1;
  });
});

async function run(
  action: (() => void | Promise<void>) | undefined,
): Promise<void> {
  if (!action) return;
  busy = true;
  failure = null;
  try {
    await action();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    failure = err.message;
    onerror?.(err);
  } finally {
    busy = false;
  }
}
</script>

<div class="model-status {className}" data-status={snapshot.status}>
  <div class="header">
    <span class="label">{label}</span>
    <span class="state" role="status">{STATUS_LABEL[snapshot.status]}</span>
  </div>

  {#if snapshot.status === 'unavailable'}
    <p class="hint">
      This browser does not expose WebGPU, so the model cannot run here.
      Inference will use the server route instead.
    </p>
  {:else if snapshot.status === 'loading'}
    <DownloadProgress
      progress={snapshot.progress ?? null}
      label="Downloading model"
      showPercent
      showBytes
    />
  {/if}

  {#if failure}
    <p class="error" role="alert">{failure}</p>
  {/if}

  <div class="actions">
    {#if (snapshot.status === 'idle' || snapshot.status === 'error') && backend.load}
      <Button onclick={() => run(() => backend.load?.())} disabled={busy}>
        {snapshot.status === 'error' ? 'Retry' : 'Load model'}
      </Button>
    {:else if snapshot.status === 'ready' && allowUnload && backend.unload}
      <Button
        variant="secondary"
        onclick={() => run(() => backend.unload?.())}
        disabled={busy}
      >
        Unload
      </Button>
    {/if}
  </div>
</div>

<style>
  .model-status {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-sm, 8px);
    padding: var(--smrt-spacing-md, 12px);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-radius: var(--smrt-radius-medium, 8px);
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--smrt-spacing-sm, 8px);
  }

  .label {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .state {
    font: var(--smrt-typography-body-small-font, 0.8125rem / 1.2 sans-serif);
    color: var(--smrt-color-on-surface-variant, #44474f);
  }

  .model-status[data-status='ready'] .state {
    color: var(--smrt-color-primary, #005ac1);
  }

  .model-status[data-status='error'] .state {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .hint,
  .error {
    margin: 0;
    font: var(--smrt-typography-body-small-font, 0.8125rem / 1.2 sans-serif);
    color: var(--smrt-color-on-surface-variant, #44474f);
  }

  .error {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-sm, 8px);
  }
</style>
