<script lang="ts">
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import Container from './Container.svelte';

const { t } = useI18n();

export interface Props {
  date?: string;
  dateHref?: string;
  location?: string;
  locationHref?: string;
  nav?: Snippet;
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

<div class="masthead">
  <Container>
    <!-- Desktop layout -->
    <div class="subheader desktop">
      <div class="left">
        {#if location}
          <a href={locationHref} class="location">{location}</a>
        {/if}
      </div>
      <div class="center">
        {#if dateHref}
          <a href={dateHref} class="date-link"><time>{date}</time></a>
        {:else}
          <time>{date}</time>
        {/if}
      </div>
      <div class="right">
        {#if nav}
          <nav class="nav">
            {@render nav()}
          </nav>
        {/if}
      </div>
    </div>

    <!-- Mobile layout -->
    <div class="subheader mobile">
      <div class="left">
        <a href={locationHref} class="home-icon" aria-label={t(M['ui.masthead.home'])}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>
            <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </a>
      </div>
      <div class="right">
        {#if mobileNav}
          <nav class="nav mobile-nav">
            {@render mobileNav()}
          </nav>
        {:else if nav}
          <nav class="nav">
            {@render nav()}
          </nav>
        {/if}
      </div>
    </div>
  </Container>
</div>

<style>
  .masthead {
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  .subheader {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: var(--smrt-spacing-4) 0;
    font-size: var(--smrt-typography-body-medium-size);
  }

  .subheader.desktop {
    display: grid;
  }

  .subheader.mobile {
    display: none;
  }

  .left {
    justify-self: start;
  }

  .center {
    justify-self: center;
  }

  .right {
    justify-self: end;
  }

  time {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }

  .date-link {
    text-decoration: none;
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }

  .date-link:hover {
    color: var(--smrt-color-primary);
  }

  .date-link:hover time {
    color: var(--smrt-color-primary);
  }

  .location {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-body-medium-weight);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: var(--smrt-typography-body-small-size);
    text-decoration: none;
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }

  .location:hover {
    color: var(--smrt-color-primary);
  }

  .nav {
    display: flex;
    gap: var(--smrt-spacing-6);
  }

  .nav :global(a) {
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-body-medium-weight);
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
    font-size: var(--smrt-typography-body-medium-size);
  }

  .nav :global(a:hover) {
    color: var(--smrt-color-primary);
  }

  /* Mobile icon nav */
  .home-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    padding: var(--smrt-spacing-1);
    transition: color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }

  .home-icon:hover {
    color: var(--smrt-color-primary);
  }

  .home-icon svg {
    width: 20px;
    height: 20px;
  }

  .mobile-nav {
    gap: var(--smrt-spacing-6);
  }

  .mobile-nav :global(a) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-1);
  }

  .mobile-nav :global(svg) {
    width: 20px;
    height: 20px;
  }

  @media (max-width: 640px) {
    .subheader.desktop {
      display: none;
    }

    .subheader.mobile {
      display: flex;
      justify-content: space-between;
      align-items: center;
      grid-template-columns: unset;
    }

    .mobile .left,
    .mobile .right {
      justify-self: unset;
    }
  }
</style>
