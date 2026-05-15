<script lang="ts">
/**
 * Test harness for verifying RoleShell re-renders when `currentRole` changes.
 *
 * Exposes a `setCurrentRole` setter via the `onReady` callback so the test
 * can flip the active role from the outside, then assert the rendered nav
 * tree + role color update accordingly.
 */
import { createRawSnippet } from 'svelte';
import RoleShell from '../RoleShell.svelte';
import type { RoleConfig } from '../types.js';

interface Props {
  roles: RoleConfig[];
  initialRole: string;
  currentPath: string;
  onReady?: (controls: { setCurrentRole: (id: string) => void }) => void;
}

const { roles, initialRole, currentPath, onReady }: Props = $props();

let currentRole = $state(initialRole);

const content = createRawSnippet(() => ({
  render: () => '<span>switch-harness</span>',
}));

onReady?.({
  setCurrentRole: (id: string) => {
    currentRole = id;
  },
});
</script>

<RoleShell {roles} {currentRole} {currentPath}>
  {@render content()}
</RoleShell>
