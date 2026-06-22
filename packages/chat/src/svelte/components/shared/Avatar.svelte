<script lang="ts">
/**
 * Avatar — chat profile avatar with online-presence indicator.
 *
 * Thin adapter over the shared `@happyvertical/smrt-ui` `Avatar` primitive
 * (S10 consolidation, #1415): it keeps chat's prop vocabulary
 * (`avatarUrl` / `onlineStatus`) but delegates rendering, the initials +
 * image-error fallback, presence dot, tokens, and a11y to the library so that
 * logic lives in exactly one place.
 */
import { Avatar as UiAvatar } from '@happyvertical/smrt-ui';

export interface Props {
  /** Display name used for initials fallback. */
  name: string;
  /** URL for the avatar image. */
  avatarUrl?: string;
  /** Online presence status. */
  onlineStatus?: 'online' | 'away' | 'dnd' | 'offline';
  /** Avatar size. */
  size?: 'sm' | 'md' | 'lg';
}

const { name, avatarUrl, onlineStatus, size = 'md' }: Props = $props();

// chat's "dnd" maps to the library's "busy" presence value.
const status = $derived(onlineStatus === 'dnd' ? 'busy' : onlineStatus);
</script>

<UiAvatar {name} src={avatarUrl} {size} {status} />
