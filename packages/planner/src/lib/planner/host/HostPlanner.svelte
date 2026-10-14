<script lang="ts">
import { onMount } from 'svelte';
import Planner from '../Planner.svelte';
import {
  type CallKitchenTool,
  createHostSession,
  type HostPlan,
  type HostSession,
} from './session.svelte.ts';

/**
 * The planner inside a Kitchen host (an MCP app or widget): the complete
 * `Planner` over a host session that reads and writes the plan through the
 * host's tools, reconnecting while the page is visible.
 */
interface HostPlannerProps {
  /** Calls one of the host's Kitchen tools by name with its arguments. */
  callTool: CallKitchenTool;
  /** A plan the host already holds, received before the first connection. */
  initial?: HostPlan;
  /** Called once the session is mounted, with the session to drive it. */
  onready?: (session: HostSession) => void;
}

let { callTool, initial, onready }: HostPlannerProps = $props();
const session = createHostSession((name, args) => callTool(name, args));
onMount(() => {
  const stop = session.mount();
  if (initial) session.receive(initial);
  const refresh = setInterval(() => {
    const id = session.current?.planId ?? session.pendingPlanId;
    if (
      id &&
      !session.busy &&
      !session.retryable &&
      document.visibilityState === 'visible'
    ) {
      void session.connect(id);
    }
  }, 1500);
  try {
    onready?.(session);
  } catch (cause) {
    session.reportError(cause);
  }
  return () => {
    clearInterval(refresh);
    stop();
  };
});
</script>
{#if session.error}<p role="alert">{session.error}</p>{/if}
{#if session.preservedDraft}
  <details><summary>Preserved edit</summary><textarea readonly value={JSON.stringify(session.preservedDraft, null, 2)} aria-label="Preserved cookbook edit"></textarea></details>
  <button type="button" onclick={() => session.dismissPreservedDraft()}>Dismiss preserved edit</button>
{/if}
{#if session.retryable}
  <button disabled={session.busy} onclick={() => session.retry()}>Retry same edit</button>
{/if}
{#if session.current}
  <fieldset disabled={session.locked} aria-busy={session.busy}>
    <Planner persistence="host" themeControls={true} />
  </fieldset>
{:else}<p role="status">Waiting for a Kitchen plan…</p>{/if}
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
fieldset { border: 0; padding: 0; min-width: 0; } textarea { width: 100%; min-height: 12rem; }
}
</style>
