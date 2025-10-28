<script lang="ts">
import type { Snippet } from 'svelte';
import Container from './Container.svelte';

interface Props {
  date?: string;
  location?: string;
  nav?: Snippet;
}

const {
  date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
  location = '',
  nav,
}: Props = $props();
</script>

<div class="masthead">
  <Container>
    <div class="subheader">
      <div class="left">
        <time>{date}</time>
      </div>
      <div class="center">
        {#if location}
          <span class="location">{location}</span>
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

  .location {
    color: var(--color-text-secondary);
    font-weight: var(--font-weight-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: var(--font-size-xs);
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

  @media (max-width: 768px) {
    .subheader {
      grid-template-columns: 1fr;
      gap: var(--spacing-sm);
      text-align: center;
    }

    .left,
    .center,
    .right {
      justify-self: center;
    }

    .nav {
      flex-wrap: wrap;
      justify-content: center;
      gap: var(--spacing-md);
    }
  }
</style>
