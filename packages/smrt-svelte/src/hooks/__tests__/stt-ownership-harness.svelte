<script lang="ts">
/**
 * R4 harness: sets a fake app-state manager on context, then mounts/unmounts
 * `useSTT()` consumers so the test can prove per-hook ownership — unmounting a
 * consumer that did NOT start listening must not stop the shared singleton.
 */
import type { SmrtAppStateManager } from '../../state/app-state.svelte.js';
import { setAppStateContext } from '../../state/context.js';
import type { UseSTTReturn } from '../useSTT.svelte.js';
import SttConsumer from './stt-consumer.fixture.svelte';

interface Props {
  manager: SmrtAppStateManager;
  showA?: boolean;
  showB?: boolean;
  onReadyA?: (stt: UseSTTReturn) => void;
  onReadyB?: (stt: UseSTTReturn) => void;
  autoStartA?: boolean;
  autoStartB?: boolean;
}

const {
  manager,
  showA = true,
  showB = true,
  onReadyA,
  onReadyB,
  autoStartA = false,
  autoStartB = false,
}: Props = $props();

// Context is set once during setup with the initial manager (test-only).
// svelte-ignore state_referenced_locally
setAppStateContext(manager);
</script>

{#if showA}
  <SttConsumer onReady={onReadyA} autoStart={autoStartA} />
{/if}
{#if showB}
  <SttConsumer onReady={onReadyB} autoStart={autoStartB} />
{/if}
