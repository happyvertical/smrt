<script lang="ts">
/**
 * Test consumer that calls the real `useSTT()` hook so its `onDestroy`
 * per-hook ownership logic (R4) runs when this component unmounts.
 */
import { type UseSTTReturn, useSTT } from '../useSTT.svelte.js';

interface Props {
  /** Hand the live hook back to the test so it can call start()/stop(). */
  onReady?: (stt: UseSTTReturn) => void;
  /** If true, start a listening session as soon as this consumer mounts. */
  autoStart?: boolean;
}

const { onReady, autoStart = false }: Props = $props();

const stt = useSTT();
// This fixture intentionally snapshots props during setup (test-only).
// svelte-ignore state_referenced_locally
onReady?.(stt);
// svelte-ignore state_referenced_locally
if (autoStart) {
  void stt.start();
}
</script>
