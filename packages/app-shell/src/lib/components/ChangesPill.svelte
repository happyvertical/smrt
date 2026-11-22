<script lang="ts">
import { planPill } from '$lib/ui/changes';
import type { ChangesState } from '$lib/ui/types';

/** The header's one "N changes waiting" pill; nothing at all when none wait. */
let {
  changes,
  current = false,
}: { changes: ChangesState | null | undefined; current?: boolean } = $props();
const plan = $derived(planPill(changes));
</script>

{#if plan}
  <a
    class="smrt-changes-pill__root"
    class:smrt-changes-pill__bad={plan.state === 'blocked'}
    href="/changes"
    aria-label={plan.label}
    aria-current={current ? 'page' : undefined}
    data-state={plan.state}
    data-testid="changes-pill"
  >
    {#if plan.state === 'checking'}
      <span class="smrt-changes-pill__spin" aria-hidden="true"></span>
    {:else}
      <span class="smrt-changes-pill__n" aria-hidden="true">{plan.state === 'blocked' ? '!' : plan.count}</span>
    {/if}
    <span class="smrt-changes-pill__long" aria-hidden="true">{plan.long}</span>
    <span class="smrt-changes-pill__short" aria-hidden="true">{plan.short}</span>
  </a>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-changes-pill__root {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    block-size: 2rem;
    padding-inline: 0.3rem 0.75rem;
    white-space: nowrap;
  }
  .smrt-changes-pill__n {
    display: inline-grid;
    place-items: center;
    min-inline-size: 1.5rem;
    block-size: 1.5rem;
    padding-inline: 0.35rem;
  }
  .smrt-changes-pill__spin {
    inline-size: 0.9rem;
    block-size: 0.9rem;
    margin-inline-start: 0.35rem;
  }
  .smrt-changes-pill__short {
    display: none;
  }
  @media (max-width: 30rem) {
    .smrt-changes-pill__long {
      display: none;
    }
    .smrt-changes-pill__short {
      display: inline;
    }
  }
  @keyframes smrt-changes-spin {
    to {
      transform: rotate(360deg);
    }
  }
}

@layer smrt.theme {
  .smrt-changes-pill__root {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-changes-pill__root:hover {
    border-color: var(--smrt-color-on-primary-container);
  }
  .smrt-changes-pill__root:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .smrt-changes-pill__n {
    /* Button-only shade (5:1 with white); the global primary token is unchanged. */
    background: var(--smrt-app-shell-action, var(--smrt-color-primary));
    color: var(--smrt-color-on-primary);
  }
  .smrt-changes-pill__bad {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-changes-pill__bad .smrt-changes-pill__n {
    background: var(--smrt-color-error);
    color: var(--smrt-color-surface);
  }
  .smrt-changes-pill__root {
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-full);
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
  }
  .smrt-changes-pill__n {
    border-radius: var(--smrt-radius-full);
    font-size: 0.8125rem;
    font-weight: 700;
  }
  .smrt-changes-pill__spin {
    border: 2px solid currentColor;
    border-inline-end-color: transparent;
    border-radius: 50%;
    animation: smrt-changes-spin 0.8s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-changes-pill__spin {
      animation: none;
    }
  }
}
</style>
