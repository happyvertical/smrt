<script lang="ts">
import type { ReactionKind, ReactionTally } from '../types.js';

interface Props {
  /** Authorized aggregate counts and selected reaction state for the current actor. */
  reactions: ReactionTally[];
  /** Prevents changes when the host does not permit interaction. */
  disabled?: boolean;
  /** Applies the desired reaction state through a host-authorized service action. */
  onChange: (kind: ReactionKind, active: boolean) => Promise<void>;
}
let { reactions, disabled = false, onChange }: Props = $props();
let busy = $state(false);
let error = $state('');
async function change(kind: ReactionKind, active: boolean) {
  if (disabled || busy) return;
  busy = true;
  error = '';
  try {
    await onChange(kind, active);
  } catch {
    error = 'Unable to update reaction. Please try again.';
  } finally {
    busy = false;
  }
}
</script>
<div role="group" aria-label="Reactions" aria-busy={busy} data-smrt-component="ReactionBar">
  {#each reactions as reaction (reaction.kind)}
    <button type="button" disabled={disabled || busy} aria-pressed={reaction.selected} onclick={() => change(reaction.kind, !reaction.selected)}>{reaction.kind} <span>{reaction.count}</span></button>
  {/each}
</div>
{#if error}<p role="alert" data-smrt-component="ReactionBar">{error}</p>{/if}
