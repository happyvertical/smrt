<script lang="ts">
/**
 * Runs a caller-supplied ShellState mutation inside a consumer $effect. Tests
 * use this to prove ShellState's internal reads do not become dependencies of
 * the consumer effect.
 */
import type { ShellState } from '../admin-shell/state.svelte.js';
import type { ShellActivity } from '../admin-shell/types.js';

type EffectCleanup = () => void;

interface MutationInputs {
  activity: ShellActivity;
}

interface Props {
  shell: ShellState;
  run: (shell: ShellState, inputs: MutationInputs) => EffectCleanup | undefined;
  onReady: (controls: {
    getRuns: () => number;
    setActivityProgress: (progress: number) => void;
  }) => void;
}

const props: Props = $props();
const activity = $state<ShellActivity>({
  id: 'reactive-sync',
  label: 'Reactive sync',
  kind: 'sync',
  scope: 'system',
  status: 'running',
  progress: 0,
});

// Plain let on purpose: making this $state would add tracking noise to the
// effect-leak signal this harness exists to measure.
let runs = 0;

$effect(() => {
  runs += 1;
  return props.run(props.shell, { activity });
});

// This harness intentionally snapshots the callback during setup.
// svelte-ignore state_referenced_locally
props.onReady({
  getRuns: () => runs,
  setActivityProgress: (progress: number) => {
    activity.progress = progress;
  },
});
</script>
