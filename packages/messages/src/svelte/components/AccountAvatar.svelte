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
  class="avatar avatar--{size}"
  class:avatar--email={['imap', 'smtp', 'pop3', 'gmail'].includes(providerType)}
  class:avatar--slack={providerType === 'slack'}
  class:avatar--twitter={providerType === 'twitter'}
  title={name}
  aria-label={`${name} (${providerType})`} data-smrt-component="AccountAvatar"
>
  {#if _icon}
    <span class="icon">{_icon}</span>
  {:else}
    <span class="initials">{_initials}</span>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    font-weight: var(--smrt-typography-weight-medium, 500);
    flex-shrink: 0;
  }

  .avatar--sm {
    width: 1.5rem;
    height: 1.5rem;
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
  }

  .avatar--md {
    width: 2rem;
    height: 2rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }

  .avatar--lg {
    width: 2.5rem;
    height: 2.5rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .avatar--email {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .avatar--slack {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }

  .avatar--twitter {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .icon {
    font-size: 1.1em;
  }

  .initials {
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
}
</style>
