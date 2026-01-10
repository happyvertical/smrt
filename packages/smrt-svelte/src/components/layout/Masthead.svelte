<script lang="ts">
import type { Snippet } from 'svelte';
import Container from './Container.svelte';

interface Props {
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
        <a href={locationHref} class="home-icon" aria-label="Home">
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
    border-bottom: 1px solid var(--color-neutral-gray300);
    background: var(--color-neutral-white);
  }

  .subheader {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: var(--spacing-md) 0;
    font-size: var(--font-size-sm);
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
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .date-link {
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .date-link:hover {
    color: var(--color-primary-main);
  }

  .date-link:hover time {
    color: var(--color-primary-main);
  }

  .location {
    color: var(--color-text-secondary);
    font-weight: var(--font-weight-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: var(--font-size-xs);
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .location:hover {
    color: var(--color-primary-main);
  }

  .nav {
    display: flex;
    gap: var(--spacing-lg);
  }

  .nav :global(a) {
    color: var(--color-text-primary);
    text-decoration: none;
    font-weight: var(--font-weight-medium);
    transition: color var(--transition-fast);
    font-size: var(--font-size-sm);
  }

  .nav :global(a:hover) {
    color: var(--color-primary-main);
  }

  /* Mobile icon nav */
  .home-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-primary);
    text-decoration: none;
    padding: var(--spacing-xs);
    transition: color var(--transition-fast);
  }

  .home-icon:hover {
    color: var(--color-primary-main);
  }

  .home-icon svg {
    width: 20px;
    height: 20px;
  }

  .mobile-nav {
    gap: var(--spacing-lg);
  }

  .mobile-nav :global(a) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--spacing-xs);
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
