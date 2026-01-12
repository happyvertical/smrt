<script lang="ts">
/**
 * ScheduleStatusBadge - Display schedule status with appropriate styling
 */

import Badge from '../ui/Badge.svelte';
import type { ScheduleStatus } from './types.js';
import { getScheduleStatusVariant } from './types.js';

interface Props {
  status: ScheduleStatus;
  size?: 'sm' | 'md';
}

const { status, size = 'sm' }: Props = $props();

const variant = $derived(getScheduleStatusVariant(status));
const label = $derived(status.charAt(0).toUpperCase() + status.slice(1));
</script>

<Badge {variant} {size}>
  {label}
</Badge>
