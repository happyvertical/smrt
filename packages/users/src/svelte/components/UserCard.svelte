<script lang="ts">
/**
 * UserCard - Compact user information display
 * refactored for Material 3
 */
import type { Profile } from '@happyvertical/smrt-profiles';
import { ripple } from '@happyvertical/smrt-ui';
import type { User } from '@happyvertical/smrt-users';
import UserAvatar from './UserAvatar.svelte';

export interface Props {
  /** User account containing email and identification. */
  user: User;
  /** User profile containing name and avatar data. */
  profile: Profile;
  /** User's role or position title. */
  role?: string;
  /** User status (active, pending, suspended, or inactive). */
  status?: string;
  /** Callback invoked when the card is clicked. */
  onclick?: () => void;
  /** Indicates whether the card is in a selected state. */
  selected?: boolean;
}

const {
  user,
  profile,
  role,
  status,
  onclick,
  selected = false,
}: Props = $props();

const statusClass = $derived.by(() => {
  switch (status) {
    case 'active':
      return 'smrt-user-card__status-active';
    case 'pending':
      return 'smrt-user-card__status-pending';
    case 'suspended':
      return 'smrt-user-card__status-error';
    case 'inactive':
      // `inactive` is the real UserStatus value (there is no `deactivated`).
      return 'smrt-user-card__status-disabled';
    default:
      return '';
  }
});
</script>

<!-- raw-primitive-allow: large pressable selection card wrapping rich content (avatar, name, email, role/status) with selected state and ripple; no Button primitive owns this structural pattern -->
<button
  type="button"
  class="smrt-user-card__root"
  class:smrt-user-card__selected={selected}
  class:smrt-user-card__clickable={!!onclick}
  onclick={onclick}
  disabled={!onclick}
  use:ripple data-smrt-component="UserCard"
>
  <UserAvatar {profile} size="md" />

  <div class="smrt-user-card__info" data-smrt-part="body">
    <div class="smrt-user-card__name" data-smrt-part="name">{profile.name}</div>
    <div class="smrt-user-card__email" data-smrt-part="email">{user.email}</div>
  </div>

  <div class="smrt-user-card__meta" data-smrt-part="meta">
    {#if role}
      <span class="smrt-user-card__role" data-smrt-part="badge">{role}</span>
    {/if}
    {#if status}
      <span class="smrt-user-card__status {statusClass}" data-smrt-part="status">{status}</span>
    {/if}
  </div>
</button>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-user-card__root {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    width: 100%;
    cursor: default;
    position: relative;
    overflow: hidden;
  }
  .smrt-user-card__root.smrt-user-card__clickable {
    cursor: pointer;
  }
  .smrt-user-card__info {
    flex: 1;
    min-width: 0;
  }
  .smrt-user-card__name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-user-card__email {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-user-card__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    flex-shrink: 0;
  }
  .smrt-user-card__role {
    padding: 0 var(--smrt-spacing-2);
    height: 20px;
    display: inline-flex;
    align-items: center;
  }
  .smrt-user-card__status {
    padding: 0 var(--smrt-spacing-2);
    height: 20px;
    display: inline-flex;
    align-items: center;
  }
}

@layer smrt.theme {
  .smrt-user-card__root {
    background-color: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-lg);
    text-align: left;
    border: none;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-user-card__root.smrt-user-card__clickable:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-2);
  }
  .smrt-user-card__root.smrt-user-card__selected {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-user-card__name {
    font: var(--smrt-typography-title-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-user-card__email {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-user-card__selected .smrt-user-card__email {
    color: var(--smrt-color-on-secondary-container);
    opacity: 0.8;
  }
  .smrt-user-card__role {
    font: var(--smrt-typography-label-small-font);
    background-color: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-lg);
    text-transform: capitalize;
  }
  .smrt-user-card__status {
    font: var(--smrt-typography-label-small-font);
    border-radius: var(--smrt-radius-lg);
    text-transform: capitalize;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-user-card__status-active {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-user-card__status-pending {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-user-card__status-error {
    background-color: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-user-card__status-disabled {
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>