<script lang="ts">
/**
 * The shell brand: logo, title, subtitle and an optional home link. Rendered
 * by `AdminShell` in its top band, or by `AppShell` as the movable
 * `item:brand` slot item (default slot `header.start`).
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';

interface Props {
  title?: string;
  subtitle?: string;
  homeHref?: string;
  logoSrc?: string;
  logoAlt?: string;
  /** Custom brand content, receiving whether it is in the compact rail. */
  brand?: Snippet<[{ compact: boolean }]>;
  /** Compact (rail) form: logo or the title's first letter. */
  compact?: boolean;
}

let {
  title = 'SMRT',
  subtitle = '',
  homeHref,
  logoSrc,
  logoAlt = '',
  brand,
  compact = false,
}: Props = $props();
const { t } = useI18n();
</script>

{#snippet content()}
  {#if brand}
    {@render brand({ compact })}
  {:else}
    {#if logoSrc}<img class="smrt-admin-shell__logo" src={logoSrc} alt={logoAlt} />{/if}
    {#if compact}
      {#if !logoSrc}<span aria-hidden="true">{title.charAt(0)}</span>{/if}
    {:else}
      <div class="smrt-admin-shell__brand-text" class:wordmark={Boolean(logoSrc) && !subtitle}><strong>{title}</strong>{#if subtitle}<span>{subtitle}</span>{/if}</div>
    {/if}
  {/if}
{/snippet}

{#if homeHref}
  <a class="smrt-admin-shell__brand smrt-admin-shell__brand-link" class:compact href={homeHref} aria-label={title || t(M['ui.admin_shell.home'])}>
    {@render content()}
  </a>
{:else}
  <div class="smrt-admin-shell__brand" class:compact>{@render content()}</div>
{/if}

<style>
  .smrt-admin-shell__brand {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .smrt-admin-shell__brand-text { display: grid; min-width: 0; }
  .smrt-admin-shell__brand.compact { justify-content: center; margin-block-end: var(--smrt-spacing-2); }
  .smrt-admin-shell__brand-link:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-admin-shell__logo { inline-size: 2rem; block-size: 2rem; object-fit: contain; flex-shrink: 0; }

  .smrt-admin-shell__brand strong,
  .smrt-admin-shell__brand span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-admin-shell__brand span {
    color: var(--smrt-color-on-surface-variant);
  }

  /* Logo and title alone ([logo] Planner): the title reads as a wordmark,
     its line as tall as the 2rem logo. */
  .smrt-admin-shell__brand-text.wordmark strong {
    font: var(--smrt-typography-headline-small-font, 500 1.5rem/2rem sans-serif);
  }
</style>
