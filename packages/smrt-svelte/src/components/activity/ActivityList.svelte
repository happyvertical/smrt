<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Chip } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.workspace.js';
import ActivityItem from '../workspace/admin-shell/ActivityItem.svelte';
import type { ActivityListControls, ActivityListEntry } from './types.js';

export interface Props extends ActivityListControls {
  /** Already-authorized activity rows to display. */
  entries: ActivityListEntry[];
  /** Optional reference epoch (ms) for deterministic relative timestamp rendering in tests. */
  now?: number;
}

let {
  entries,
  emptyLabel,
  caughtUpLabel,
  sourceFilter,
  onDismiss,
  onDismissMany,
  onRestore,
  canUndo = false,
  onUndo,
  dismissedCount,
  showDismissed,
  onToggleShowDismissed,
  now,
}: Props = $props();

const { t } = useI18n();

let selectedSource = $state<string | null>(null);
let localShowDismissed = $state(false);

interface SourceOption {
  key: string;
  label: string;
}

function sourceKeyOf(entry: ActivityListEntry): string {
  return entry.source?.trim() || entry.sourceLabel?.trim() || '';
}

function sourceLabelOf(entry: ActivityListEntry): string {
  return entry.sourceLabel?.trim() || entry.source?.trim() || '';
}

const sources = $derived.by((): SourceOption[] => {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = sourceKeyOf(entry);
    if (!key || seen.has(key)) continue;
    seen.set(key, sourceLabelOf(entry));
  }
  return Array.from(seen, ([key, label]) => ({ key, label }));
});

const showSources = $derived(
  sourceFilter === true
    ? sources.length >= 1
    : sourceFilter === false
      ? false
      : sources.length >= 2,
);

const activeSource = $derived(
  selectedSource && sources.some((source) => source.key === selectedSource)
    ? selectedSource
    : null,
);

const effectiveShowDismissed = $derived(showDismissed ?? localShowDismissed);

const inListDismissedCount = $derived(
  entries.filter((entry) => entry.dismissed).length,
);

const effectiveDismissedCount = $derived(
  dismissedCount ?? inListDismissedCount,
);

const canToggleDismissed = $derived(
  Boolean(onToggleShowDismissed || inListDismissedCount > 0) &&
    (effectiveDismissedCount > 0 || effectiveShowDismissed),
);

const visibleEntries = $derived(
  entries.filter(
    (entry) =>
      (effectiveShowDismissed || !entry.dismissed) &&
      (activeSource === null || sourceKeyOf(entry) === activeSource),
  ),
);

const visibleUnreadIds = $derived(
  visibleEntries.filter((entry) => !entry.dismissed).map((entry) => entry.id),
);

const showDismissVisible = $derived(
  Boolean(onDismissMany && visibleUnreadIds.length > 0),
);

const showUndo = $derived(Boolean(canUndo && onUndo));

const showToolbar = $derived(
  showSources || showDismissVisible || showUndo || canToggleDismissed,
);

const isCaughtUp = $derived(
  visibleEntries.length === 0 &&
    (effectiveDismissedCount > 0 ||
      inListDismissedCount > 0 ||
      Boolean(canUndo && onUndo)),
);

const isFilteredEmpty = $derived(
  visibleEntries.length === 0 && !isCaughtUp && activeSource !== null,
);

function handleToggleDismissed(): void {
  if (showDismissed === undefined) {
    localShowDismissed = !localShowDismissed;
  }
  onToggleShowDismissed?.();
}
</script>

<div class="smrt-activity-feed__root" data-smrt-component="ActivityList">
  {#if showToolbar}
    <div class="smrt-activity-feed__toolbar" data-smrt-part="toolbar">
      {#if showSources}
        <div
          class="smrt-activity-feed__sources"
          role="group"
          aria-label={t(M['ui.activity_list.filter_by_source'])}
          data-smrt-part="sources"
        >
          <Chip
            size="sm"
            selectable
            selected={activeSource === null}
            onselect={() => (selectedSource = null)}
            label={t(M['ui.activity_list.filter_all'])}
          />
          {#each sources as source (source.key)}
            <Chip
              size="sm"
              selectable
              selected={activeSource === source.key}
              onselect={() => (selectedSource = source.key)}
              label={source.label}
            />
          {/each}
        </div>
      {/if}

      {#if showDismissVisible || showUndo || canToggleDismissed}
        <div class="smrt-activity-feed__controls" data-smrt-part="controls">
          {#if showUndo}
            <Button
              variant="ghost"
              size="sm"
              labelWhitespace="trim"
              onclick={() => void onUndo?.()}
            >
              {t(M['ui.activity_list.undo'])}
            </Button>
          {/if}
          {#if showDismissVisible}
            <Button
              variant="ghost"
              size="sm"
              labelWhitespace="trim"
              onclick={() => void onDismissMany?.(visibleUnreadIds)}
            >
              {t(M['ui.activity_list.dismiss_visible'])}
            </Button>
          {/if}
          {#if canToggleDismissed}
            <Button
              variant="ghost"
              size="sm"
              labelWhitespace="trim"
              aria-pressed={effectiveShowDismissed}
              onclick={handleToggleDismissed}
            >
              {t(
                effectiveShowDismissed
                  ? M['ui.activity_list.hide_dismissed']
                  : M['ui.activity_list.show_dismissed'],
                { count: effectiveDismissedCount },
              )}
            </Button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if visibleEntries.length > 0}
    <div class="smrt-activity-feed__list" data-smrt-part="list">
      {#each visibleEntries as entry (entry.id)}
        <ActivityItem {entry} {onDismiss} {onRestore} {now} />
      {/each}
    </div>
  {:else if isCaughtUp}
    <div
      class="smrt-activity-feed__caught-up"
      role="status"
      data-smrt-part="caught-up"
    >
      <span class="smrt-activity-feed__caught-up-icon" aria-hidden="true">✓</span>
      <p class="smrt-activity-feed__caught-up-text">
        {caughtUpLabel ?? t(M['ui.activity_list.caught_up'])}
      </p>
    </div>
  {:else if isFilteredEmpty}
    <p class="smrt-activity-feed__empty" data-smrt-part="empty">
      {t(M['ui.activity_list.no_matching_activity'])}
    </p>
  {:else}
    <p class="smrt-activity-feed__empty" data-smrt-part="empty">
      {emptyLabel ?? t(M['ui.activity_list.no_activity'])}
    </p>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-activity-feed__root {
    display: grid;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
  }
  .smrt-activity-feed__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
    padding-block-end: var(--smrt-spacing-1);
  }
  .smrt-activity-feed__sources {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-1);
    min-inline-size: 0;
  }
  .smrt-activity-feed__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--smrt-spacing-1);
    margin-inline-start: auto;
  }
  .smrt-activity-feed__list {
    display: grid;
    min-inline-size: 0;
  }
  .smrt-activity-feed__caught-up {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-3);
  }
  .smrt-activity-feed__caught-up-icon {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    inline-size: 1.5rem;
    block-size: 1.5rem;
  }
  .smrt-activity-feed__caught-up-text,
  .smrt-activity-feed__empty {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-activity-feed__toolbar {
    border-block-end: var(--smrt-hairline);
  }
  .smrt-activity-feed__caught-up {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-activity-feed__caught-up-icon {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size);
    font-weight: var(--smrt-typography-weight-bold);
  }
  .smrt-activity-feed__caught-up-text,
  .smrt-activity-feed__empty {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size);
  }
}
</style>
