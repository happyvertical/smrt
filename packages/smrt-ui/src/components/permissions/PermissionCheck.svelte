<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
  /** Single permission to check */
  permission?: string;
  /** Multiple permissions to check */
  permissions?: string[];
  /** User's current permissions */
  userPermissions: string[];
  /** 'all' requires all permissions, 'any' requires at least one */
  mode?: 'all' | 'any';
  /** Content to show when permission check passes */
  children: Snippet;
  /** Optional fallback content when check fails */
  fallback?: Snippet;
}

const {
  permission,
  permissions = [],
  userPermissions,
  mode = 'all',
  children,
  fallback,
}: Props = $props();

const requiredPermissions = $derived(permission ? [permission] : permissions);

const hasAccess = $derived(() => {
  if (requiredPermissions.length === 0) return true;

  if (mode === 'any') {
    return requiredPermissions.some((p) => userPermissions.includes(p));
  }

  return requiredPermissions.every((p) => userPermissions.includes(p));
});
</script>

{#if hasAccess()}
  {@render children()}
{:else if fallback}
  {@render fallback()}
{/if}
