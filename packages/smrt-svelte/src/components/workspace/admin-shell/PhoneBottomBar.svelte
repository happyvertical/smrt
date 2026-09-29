<script lang="ts">
/**
 * Phone bottom bar: 56px plus the safe-area inset, an icon and a short
 * label per item. Items are data: a link (`href`) or a button (`onclick`),
 * with an active state, an optional count badge, and an optional dot.
 * Render it in AdminShell's `phoneBottomBar` snippet: the shell hides it
 * while a form's action bar is on screen or the keyboard is open.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.workspace.js';
import type { PhoneBottomBarItem } from './mobile-shell.js';

interface Props {
  /** Bar entries, left to right. */
  items: PhoneBottomBarItem[];
  /** Accessible name of the nav landmark (default "Main"). */
  label?: string;
}

let { items, label }: Props = $props();

const { t } = useI18n();

function accessibleName(item: PhoneBottomBarItem): string {
  const parts = [item.label];
  if (item.badge) {
    parts.push(
      t(M['ui.phone_bottom_bar.unread'], { count: String(item.badge) }),
    );
  }
  if (item.dot) parts.push(item.dotLabel ?? t(M['ui.phone_bottom_bar.new']));
  return parts.join(', ');
}
</script>

{#snippet content(item: PhoneBottomBarItem)}
  <span class="smrt-phone-bottom-bar__icon" aria-hidden="true">
    <item.icon size={22} />
    {#if item.badge}
      <span class="smrt-phone-bottom-bar__badge">
        {item.badge > 9 ? '9+' : item.badge}
      </span>
    {:else if item.dot}
      <span class="smrt-phone-bottom-bar__dot"></span>
    {/if}
  </span>
  <span class="smrt-phone-bottom-bar__label" aria-hidden="true">{item.label}</span>
{/snippet}

<nav
  class="smrt-phone-bottom-bar"
  aria-label={label ?? t(M['ui.phone_bottom_bar.label'])}
  data-testid="phone-bottom-bar"
>
  {#each items as item (item.id)}
    {#if item.href}
      <a
        class="smrt-phone-bottom-bar__item"
        class:active={item.active}
        href={item.href}
        aria-label={accessibleName(item)}
        aria-current={item.active ? 'page' : undefined}
        data-item={item.id}
        onclick={item.onclick}
      >
        {@render content(item)}
      </a>
    {:else}
      <!-- raw-primitive-allow: shell chrome toggle, not a content button -->
      <button
        type="button"
        class="smrt-phone-bottom-bar__item"
        class:active={item.active}
        aria-label={accessibleName(item)}
        aria-expanded={item.expanded}
        aria-controls={item.controls}
        data-item={item.id}
        onclick={item.onclick}
      >
        {@render content(item)}
      </button>
    {/if}
  {/each}
</nav>

<style>
  .smrt-phone-bottom-bar {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    gap: var(--smrt-spacing-2);
    box-sizing: content-box;
    block-size: 3.5rem;
    padding: 0 var(--smrt-spacing-2) env(safe-area-inset-bottom);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  .smrt-phone-bottom-bar__item {
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--smrt-spacing-1);
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    padding: var(--smrt-spacing-1) 0;
    border: 0;
    border-radius: var(--smrt-radius-lg);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .smrt-phone-bottom-bar__item.active {
    color: var(--smrt-color-primary);
  }

  .smrt-phone-bottom-bar__item.active .smrt-phone-bottom-bar__icon {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .smrt-phone-bottom-bar__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .smrt-phone-bottom-bar__icon {
    position: relative;
    display: grid;
    place-items: center;
    inline-size: 3.5rem;
    block-size: 1.75rem;
    border-radius: var(--smrt-radius-full);
  }

  .smrt-phone-bottom-bar__label {
    font: var(--smrt-typography-label-small-font);
  }

  .smrt-phone-bottom-bar__badge {
    position: absolute;
    inset-block-start: -0.2rem;
    inset-inline-end: 0.6rem;
    box-sizing: border-box;
    min-inline-size: 1.1rem;
    block-size: 1.1rem;
    padding: 0 var(--smrt-spacing-1);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
    font: var(--smrt-typography-label-small-font);
    line-height: 1.1rem;
    text-align: center;
  }

  .smrt-phone-bottom-bar__dot {
    position: absolute;
    inset-block-start: 0.1rem;
    inset-inline-end: 1rem;
    inline-size: 0.6rem;
    block-size: 0.6rem;
    border: 2px solid var(--smrt-color-surface);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
  }
</style>
