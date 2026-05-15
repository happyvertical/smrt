<script lang="ts">
/**
 * Test harness for `bind:mobileNavOpen` on `WorkspaceShell`.
 *
 * Exposes the bindable drawer state on the outer `state` object so tests
 * can observe the consumer-visible value after every interaction. The
 * `onReady` callback hands back a setter the test can use to drive the
 * value externally — verifying the two-way binding really is two-way.
 */
import { createRawSnippet } from 'svelte';
import WorkspaceShell from '../WorkspaceShell.svelte';

interface Props {
  initial?: boolean;
  onReady?: (controls: {
    setMobileNavOpen: (next: boolean) => void;
    getMobileNavOpen: () => boolean;
  }) => void;
}

const { initial = false, onReady }: Props = $props();

let mobileNavOpen = $state(initial);

const content = createRawSnippet(() => ({
  render: () => '<span>content</span>',
}));

onReady?.({
  setMobileNavOpen: (next: boolean) => {
    mobileNavOpen = next;
  },
  getMobileNavOpen: () => mobileNavOpen,
});
</script>

<WorkspaceShell bind:mobileNavOpen>
  {@render content()}
</WorkspaceShell>
