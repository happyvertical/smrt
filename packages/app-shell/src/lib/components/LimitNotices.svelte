<script lang="ts">
import { invalidate } from '$app/navigation';
import { DEPENDS } from '$lib/ui/events';

/** What a cap or limit refused lately (#5198), as the layout loaded it. */
interface Notice {
  kind: 'cap' | 'route' | 'period';
  cap?: string;
  message: string;
  count: number;
  lastAt: string;
}

let { notices = [] }: { notices?: readonly Notice[] } = $props();
let failed = $state(false);

const title = (n: Notice) =>
  n.kind === 'route'
    ? 'Requests to your app are being limited'
    : n.kind === 'period'
      ? 'Your plan’s request limit is used up'
      : 'Your app reached a limit';
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

async function dismiss() {
  failed = false;
  try {
    const r = await fetch('/api/shell/limit-notices', { method: 'DELETE' });
    if (!r.ok) throw new Error(String(r.status));
    await invalidate(DEPENDS.shell);
  } catch {
    failed = true;
  }
}
</script>

{#if notices.length > 0}
  <section class="smrt-limit-notices__root" role="status" aria-live="polite" data-testid="limit-notices" data-smrt-component="LimitNotices">
    {#each notices as n (n.kind + (n.cap ?? ''))}
      <p class="smrt-limit-notices__item" data-kind={n.kind}>
        <strong>{title(n)}.</strong>
        {n.message}
        <span class="smrt-limit-notices__count">Refused {times(n.count)}.</span>
      </p>
    {/each}
    <button type="button" class="smrt-limit-notices__dismiss" onclick={dismiss}>Dismiss</button>
    {#if failed}<span class="smrt-limit-notices__failed">Could not dismiss. Try again.</span>{/if}
  </section>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-limit-notices__root {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    margin-block-end: var(--smrt-spacing-md, 0.75rem);
  }
  .smrt-limit-notices__item {
    margin: 0;
    flex: 1 1 20rem;
  }
}

@layer smrt.theme {
  .smrt-limit-notices__root {
    border: thin solid var(--smrt-color-warning);
    border-radius: var(--smrt-radius-md, 0.5rem);
  }
  .smrt-limit-notices__count,
  .smrt-limit-notices__failed {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}
</style>
