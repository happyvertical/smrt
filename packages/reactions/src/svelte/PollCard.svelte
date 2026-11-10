<script lang="ts">
import type { PollProjection } from '../types.js';

interface Props {
  /** Authorized poll options, selection and optionally visible aggregate results. */
  poll: PollProjection;
  /** Prevents voting when the host does not permit interaction. */
  disabled?: boolean;
  /** Records a choice through a host-authorized service action. */
  onVote: (optionId: string) => Promise<void>;
}
let { poll, disabled = false, onVote }: Props = $props();
let busy = $state(false);
let error = $state('');
async function vote(optionId: string) {
  if (disabled || busy || poll.closed || poll.selectedOptionId !== null) return;
  busy = true;
  error = '';
  try {
    await onVote(optionId);
  } catch {
    error = 'Unable to record vote. Please try again.';
  } finally {
    busy = false;
  }
}
</script>
<section aria-label={poll.question} aria-busy={busy} data-smrt-component="PollCard">
  <h3>{poll.question}</h3>
  {#if poll.closed}<p>Voting is closed.</p>{/if}
  <ul>
    {#each poll.options as option (option.id)}
      <li><button type="button" disabled={disabled || busy || poll.closed || poll.selectedOptionId !== null} aria-pressed={poll.selectedOptionId === option.id} onclick={() => vote(option.id)}>{option.label}</button>
        {#if poll.results !== null}<span aria-label={`${option.label} votes`}>{poll.results[option.id] ?? 0}</span>{/if}
      </li>
    {/each}
  </ul>
  {#if poll.totalVotes !== null}<p>{poll.totalVotes} total votes</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>
