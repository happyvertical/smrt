<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.workspace.js';
import ActivityList from './ActivityList.svelte';
import type { ShellSystemPanel } from './types.js';

interface Props {
  panels: ShellSystemPanel[];
  showActivities?: boolean;
}

let { panels, showActivities = true }: Props = $props();
const { t } = useI18n();
</script>

<section
  class="smrt-system-scope-panel"
  aria-label={t(M['ui.system_scope_panel.system_scope'])}
>
  {#each panels as panel (panel.id)}
    <section class="smrt-system-scope-panel__group" aria-label={panel.label}>
      <header>
        <h2>{panel.label}</h2>
        <span>{panel.items.length}</span>
      </header>
      {#if panel.items.length > 0}
        <div class="smrt-system-scope-panel__items">
          {#each panel.items as item (item.id)}
            <svelte:element
              this={item.href ? 'a' : 'span'}
              href={item.href ?? undefined}
              class="smrt-system-scope-panel__item"
              aria-disabled={item.href ? undefined : 'true'}
            >
              <strong>{item.label}</strong>
              <span>{item.status}</span>
              {#if item.detail}
                <small>{item.detail}</small>
              {/if}
            </svelte:element>
          {/each}
        </div>
      {:else}
        <p>No {panel.label.toLowerCase()}</p>
      {/if}
    </section>
  {/each}

  {#if showActivities}
    <section
      class="smrt-system-scope-panel__group"
      aria-label={t(M['ui.system_scope_panel.activities'])}
    >
      <header>
        <h2>{t(M['ui.system_scope_panel.activities'])}</h2>
      </header>
      <ActivityList
        filter={{ edge: 'bottom' }}
        emptyLabel={t(M['ui.system_scope_panel.no_running_work'])}
      />
    </section>
  {/if}
</section>

<style>
  .smrt-system-scope-panel {
    display: grid;
    gap: var(--smrt-spacing-5);
  }

  .smrt-system-scope-panel__group,
  .smrt-system-scope-panel__items {
    display: grid;
    gap: var(--smrt-spacing-2);
  }

  .smrt-system-scope-panel__group header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }

  .smrt-system-scope-panel h2,
  .smrt-system-scope-panel p {
    margin: 0;
  }

  .smrt-system-scope-panel p,
  .smrt-system-scope-panel small,
  .smrt-system-scope-panel__group header span {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-system-scope-panel__item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--smrt-spacing-1) var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) 0;
    border-block-start: 1px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .smrt-system-scope-panel__item[aria-disabled='true'] {
    color: var(--smrt-color-on-surface-variant);
    cursor: default;
  }

  .smrt-system-scope-panel__items strong,
  .smrt-system-scope-panel__items small {
    overflow-wrap: anywhere;
  }

  .smrt-system-scope-panel__items small {
    grid-column: 1 / -1;
  }
</style>
