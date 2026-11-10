<script lang="ts">
/**
 * AccountAvatar - Provider icon with fallback initials
 */

export interface Props {
  /** Email provider type such as Gmail, IMAP, or Slack. */
  providerType: string;
  /** Account or user name, displayed as title and used to generate initials. */
  name: string;
  /** Visual size of the avatar: small, medium, or large. */
  size?: 'sm' | 'md' | 'lg';
}

const { providerType, name, size = 'md' }: Props = $props();

const _initials = $derived(
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join(''),
);

const _icon = $derived.by(() => {
  switch (providerType) {
    case 'imap':
    case 'smtp':
    case 'pop3':
    case 'gmail':
      return '✉';
    case 'slack':
      return '#';
    case 'twitter':
      return '𝕏';
    default:
      return null;
  }
});
</script>

<span
  class="smrt-account-avatar__root smrt-account-avatar__{size}"
  class:smrt-account-avatar__email={['imap', 'smtp', 'pop3', 'gmail'].includes(providerType)}
  class:smrt-account-avatar__slack={providerType === 'slack'}
  class:smrt-account-avatar__twitter={providerType === 'twitter'}
  title={name}
  aria-label={`${name} (${providerType})`} data-smrt-component="AccountAvatar"
>
  {#if _icon}
    <span class="smrt-account-avatar__icon" data-smrt-part="icon">{_icon}</span>
  {:else}
    <span class="smrt-account-avatar__initials" data-smrt-part="label">{_initials}</span>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-account-avatar__root {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .smrt-account-avatar__sm {
    width: 1.5rem;
    height: 1.5rem;
  }
  .smrt-account-avatar__md {
    width: 2rem;
    height: 2rem;
  }
  .smrt-account-avatar__lg {
    width: 2.5rem;
    height: 2.5rem;
  }
}

@layer smrt.theme {
  .smrt-account-avatar__root {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-account-avatar__sm {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
  }
  .smrt-account-avatar__md {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-account-avatar__lg {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .smrt-account-avatar__email {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-account-avatar__slack {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-account-avatar__twitter {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-account-avatar__icon {
    font-size: 1.1em;
  }
  .smrt-account-avatar__initials {
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
}

</style>
