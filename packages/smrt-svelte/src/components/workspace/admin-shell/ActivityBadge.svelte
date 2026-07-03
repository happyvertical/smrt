<script lang="ts">
import { Badge } from '@happyvertical/smrt-ui/ui';
import { useAdminShell } from './context.js';
import type { PanelEdge } from './types.js';

interface Props {
  edge: PanelEdge;
  label?: string;
}

let { edge, label = 'Running activities' }: Props = $props();
const shell = useAdminShell();
const badge = $derived(shell.activityBadge(edge));
</script>

{#if badge.count > 0 || badge.hasFailed}
  <Badge
    variant={badge.hasFailed ? 'error' : 'primary'}
    size="sm"
    title={label}
    aria-label={`${label}: ${badge.count}`}
  >
    {badge.progress !== null ? `${Math.round(badge.progress)}%` : badge.count}
  </Badge>
{/if}
