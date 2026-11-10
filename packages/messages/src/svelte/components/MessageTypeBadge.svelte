<script lang="ts">
/**
 * MessageTypeBadge - Icon + label badge for message types
 */
import { Badge } from '@happyvertical/smrt-ui/ui';
import type { MessageType } from '../types.js';

export interface Props {
  /** Message type to display as a labeled badge. */
  type: MessageType;
  /** Visual size of the badge: small or medium. */
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
  <span class="smrt-message-type-badge__label" data-smrt-part="label">
    <span class="smrt-message-type-badge__icon" data-smrt-part="icon">{type === 'email' ? '✉' : type === 'tweet' ? '𝕏' : type === 'slack' ? '#' : '✉'}</span>
    {_label}
  </span>
</Badge>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-type-badge__label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
}

@layer smrt.theme {
  .smrt-message-type-badge__icon {
    font-size: 0.85em;
  }
}

</style>
