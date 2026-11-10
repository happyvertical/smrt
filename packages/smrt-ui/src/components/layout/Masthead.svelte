<script lang="ts">
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import Container from './Container.svelte';

const { t } = useI18n();

export interface Props {
  /** Formatted date string displayed in the masthead. */
  date?: string;
  /** URL for the date link; omit to make it non-interactive. */
  dateHref?: string;
  /** Location text displayed in the masthead. */
  location?: string;
  /** URL for the location link. */
  locationHref?: string;
  /** Navigation links displayed on desktop. */
  nav?: Snippet;
  /** Navigation links displayed on mobile; falls back to nav if omitted. */
  mobileNav?: Snippet;
}

const {
  date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
  dateHref,
  location = '',
  locationHref = '/',
  nav,
  mobileNav,
}: Props = $props();
</script>

<div class="smrt-masthead__root" data-smrt-component="Masthead">
  <Container>
    <!-- Desktop layout -->
    <div class="smrt-masthead__subheader smrt-masthead__desktop" data-smrt-part="row">
      <div class="smrt-masthead__left" data-smrt-part="cell">
        {#if location}
          <a href={locationHref} class="smrt-masthead__location" data-smrt-part="meta">{location}</a>
        {/if}
      </div>
      <div class="smrt-masthead__center" data-smrt-part="cell">
        {#if dateHref}
          <a href={dateHref} class="smrt-masthead__date-link" data-smrt-part="time"><time>{date}</time></a>
        {:else}
          <time>{date}</time>
        {/if}
      </div>
      <div class="smrt-masthead__right" data-smrt-part="cell">
        {#if nav}
          <nav class="smrt-masthead__nav" data-smrt-part="list" aria-label={t(M['ui.masthead.primary_nav'])}>
            {@render nav()}
          </nav>
        {/if}
      </div>
    </div>

    <!-- Mobile layout -->
    <div class="smrt-masthead__subheader smrt-masthead__mobile" data-smrt-part="row">
      <div class="smrt-masthead__left" data-smrt-part="cell">
        <a href={locationHref} class="smrt-masthead__home-icon" data-smrt-part="icon" aria-label={t(M['ui.masthead.home'])}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>
            <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </a>
      </div>
      <div class="smrt-masthead__right" data-smrt-part="cell">
        {#if mobileNav}
          <nav class="smrt-masthead__nav smrt-masthead__mobile-nav" data-smrt-part="list" aria-label={t(M['ui.masthead.mobile_nav'])}>
            {@render mobileNav()}
          </nav>
        {:else if nav}
          <nav class="smrt-masthead__nav" data-smrt-part="list" aria-label={t(M['ui.masthead.mobile_nav'])}>
            {@render nav()}
          </nav>
        {/if}
      </div>
    </div>
  </Container>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-masthead__subheader {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: var(--smrt-spacing-4) 0;
  }
  .smrt-masthead__subheader.smrt-masthead__desktop {
    display: grid;
  }
  .smrt-masthead__subheader.smrt-masthead__mobile {
    display: none;
  }
  .smrt-masthead__left {
    justify-self: start;
  }
  .smrt-masthead__center {
    justify-self: center;
  }
  .smrt-masthead__right {
    justify-self: end;
  }
  .smrt-masthead__nav {
    display: flex;
    gap: var(--smrt-spacing-6);
  }
  /* Mobile icon nav */
  .smrt-masthead__home-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-1);
  }
  .smrt-masthead__home-icon svg {
    width: 20px;
    height: 20px;
  }
  .smrt-masthead__mobile-nav {
    gap: var(--smrt-spacing-6);
  }
  .smrt-masthead__mobile-nav :global(a) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-1);
  }
  .smrt-masthead__mobile-nav :global(svg) {
    width: 20px;
    height: 20px;
  }
  @media (max-width: 640px) {
    .smrt-masthead__subheader.smrt-masthead__desktop {
      display: none;
    }
    .smrt-masthead__subheader.smrt-masthead__mobile {
      display: flex;
      justify-content: space-between;
      align-items: center;
      grid-template-columns: unset;
    }
    .smrt-masthead__mobile .smrt-masthead__left,
    .smrt-masthead__mobile .smrt-masthead__right {
      justify-self: unset;
    }
  }
}

@layer smrt.theme {
  .smrt-masthead__root {
    border-bottom: var(--smrt-hairline);
    background: var(--smrt-color-surface);
  }
  .smrt-masthead__subheader {
    font-size: var(--smrt-typography-body-medium-size);
  }
  time {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-masthead__date-link {
    text-decoration: none;
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }
  .smrt-masthead__date-link:hover {
    color: var(--smrt-color-primary);
  }
  .smrt-masthead__date-link:hover time {
    color: var(--smrt-color-primary);
  }
  .smrt-masthead__location {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-body-medium-weight);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: var(--smrt-typography-body-small-size);
    text-decoration: none;
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }
  .smrt-masthead__location:hover {
    color: var(--smrt-color-primary);
  }
  .smrt-masthead__nav :global(a) {
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-body-medium-weight);
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
    font-size: var(--smrt-typography-body-medium-size);
  }
  .smrt-masthead__nav :global(a:hover) {
    color: var(--smrt-color-primary);
  }
  /* Mobile icon nav */
  .smrt-masthead__home-icon {
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }
  .smrt-masthead__home-icon:hover {
    color: var(--smrt-color-primary);
  }
}

</style>
