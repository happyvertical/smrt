<script lang="ts">
/**
 * Phone top bar, context only: a back arrow and the page title on detail
 * pages, the workspace name (a link home) on section homes. No action
 * icons: those live in the phone bottom bar. Build the model with
 * `phoneTopBarFor()` and render this in AdminShell's `phoneTopBar`
 * snippet, which hides it on scroll.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.workspace.js';
import type { PhoneTopBarModel } from './mobile-shell.js';
import ShellTitle from './ShellTitle.svelte';

interface Props {
  /** What to show (see `phoneTopBarFor`). */
  model: PhoneTopBarModel;
  /** The workspace home page, linked from the name on section homes. */
  homeHref: string;
}

let { model, homeHref }: Props = $props();

const { t } = useI18n();
</script>

<div class="smrt-phone-top-bar" data-testid="phone-top-bar" data-kind={model.kind}>
  {#if model.kind === 'detail'}
    <a
      class="smrt-phone-top-bar__back"
      data-shell-page-navigation-replacement
      href={model.backHref}
      aria-label={t(M['ui.phone_top_bar.back'], { label: model.backLabel })}
    >
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m12 19-7-7 7-7M19 12H5" />
      </svg>
    </a>
    <span class="smrt-phone-top-bar__title" data-shell-page-title-replacement>{model.title}</span>
  {:else}
    <ShellTitle title={model.title} href={homeHref} />
  {/if}
</div>

<style>
  .smrt-phone-top-bar {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    box-sizing: border-box;
    block-size: var(--smrt-admin-shell-phone-top-size, 3.5rem);
    padding: 0 var(--smrt-spacing-2);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .smrt-phone-top-bar__back {
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    border-radius: var(--smrt-radius-full);
    color: inherit;
  }

  .smrt-phone-top-bar__back:hover,
  .smrt-phone-top-bar__back:focus-visible {
    background: var(--smrt-color-surface-container-high);
  }

  .smrt-phone-top-bar__back:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .smrt-phone-top-bar__title {
    min-inline-size: 0;
    overflow: hidden;
    font: var(--smrt-typography-title-medium-font);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
