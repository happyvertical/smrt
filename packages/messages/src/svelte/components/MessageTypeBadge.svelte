<script lang="ts">
/**
 * MessageTypeBadge - Icon + label badge for message types
 */
import { Badge } from '@happyvertical/smrt-ui/ui';
import type { MessageType } from '../types.js';

export interface Props {
  type: MessageType;
  size?: 'sm' | 'md';
}

const { type, size = 'sm' }: Props = $props();

const _label = $derived.by(() => {
  switch (type) {
    case 'email':
      return 'Email';
    case 'tweet':
      return 'Tweet';
    case 'slack':
      return 'Slack';
    default:
      return type;
  }
});

const _variant = $derived.by(() => {
  switch (type) {
    case 'email':
      return 'primary' as const;
    case 'tweet':
      return 'info' as const;
    case 'slack':
      return 'success' as const;
    default:
      return 'default' as const;
  }
});
</script>

<Badge variant={_variant} {size}>
  <span class="type-badge">
    <span class="type-icon">{type === 'email' ? '✉' : type === 'tweet' ? '𝕏' : type === 'slack' ? '#' : '✉'}</span>
    {_label}
  </span>
</Badge>

<style>
  .type-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .type-icon {
    font-size: 0.85em;
  }
</style>
