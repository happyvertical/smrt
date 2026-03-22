<script lang="ts">
/**
 * ScheduleStatusBadge - Display schedule status with appropriate styling
 */

import { Badge } from '@happyvertical/smrt-svelte/ui';
import type { ScheduleStatus } from '../types.js';
import { getScheduleStatusVariant } from '../types.js';

export interface Props {
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
