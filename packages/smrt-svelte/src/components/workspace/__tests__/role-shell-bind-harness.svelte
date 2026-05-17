<script lang="ts">
/**
 * Test harness for `bind:mobileNavOpen` on `RoleShell`. Mirrors the
 * `workspace-shell-bind-harness` pattern — exposes the bindable drawer
 * state so tests can drive and observe it from outside the component.
 */
import { createRawSnippet } from 'svelte';
import RoleShell from '../RoleShell.svelte';
import type { RoleConfig } from '../types.js';

interface Props {
  roles: RoleConfig[];
  currentRole: string;
  currentPath?: string;
  initial?: boolean;
  onNavigate?: () => void;
  onReady?: (controls: {
    setMobileNavOpen: (next: boolean) => void;
    getMobileNavOpen: () => boolean;
  }) => void;
}

const {
  roles,
  currentRole,
  currentPath = '/',
  initial = false,
  onNavigate,
  onReady,
}: Props = $props();

// This harness intentionally snapshots the initial bindable value.
// svelte-ignore state_referenced_locally
let mobileNavOpen = $state(initial);

const content = createRawSnippet(() => ({
  render: () => '<span>content</span>',
}));

// This harness intentionally snapshots the callback during setup.
// svelte-ignore state_referenced_locally
onReady?.({
  setMobileNavOpen: (next: boolean) => {
    mobileNavOpen = next;
  },
  getMobileNavOpen: () => mobileNavOpen,
});
</script>

<RoleShell
  {roles}
  {currentRole}
  {currentPath}
  {onNavigate}
  bind:mobileNavOpen
>
  {@render content()}
</RoleShell>
