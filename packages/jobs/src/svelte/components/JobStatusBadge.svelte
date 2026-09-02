<script lang="ts">
/**
 * JobStatusBadge - Display job status with appropriate styling
 */

import { Badge } from '@happyvertical/smrt-ui/ui';
import type { JobStatus } from './types.js';
import { getStatusVariant } from './types.js';

export interface Props {
  /** The job status to display. */
  status: JobStatus;
  /** Badge size. */
  size?: 'sm' | 'md';
}

const { status, size = 'sm' }: Props = $props();

const variant = $derived(getStatusVariant(status));
const label = $derived(status.charAt(0).toUpperCase() + status.slice(1));
</script>

<Badge {variant} {size}>
  {label}
</Badge>
