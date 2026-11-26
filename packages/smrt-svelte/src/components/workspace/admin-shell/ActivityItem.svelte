<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import { safeActivityHref } from '../../activity/safe-href.js';
import { formatActivityTimestamp } from '../../activity/time.js';
import type {
  ActivityListEntry,
  ActivityStatusTone,
} from '../../activity/types.js';
import type { ShellActivity } from './types.js';

const VALID_TONES = new Set<ActivityStatusTone>([
  'neutral',
  'primary',
  'success',
  'warning',
  'error',
]);

export interface Props {
  /** Shell background activity record (job status, progress, and cancel handler). */
  activity?: ShellActivity;
  /** Authorized domain activity feed entry (enriched metadata and dismissal). */
  entry?: ActivityListEntry;
  /** Callback invoked when the user dismisses `entry`. */
  onDismiss?: (id: string) => void | Promise<void>;
  /** Callback invoked when the user restores a dismissed `entry`. */
  onRestore?: (id: string) => void | Promise<void>;
  /** Shared reference epoch (ms) for deterministic relative timestamp rendering across SSR and hydration. */
  now?: number;
  /** IANA time zone for timestamp tooltips and absolute fallbacks (defaults to `'UTC'`). */
  timeZone?: string;
  /** Optional BCP-47 locale override for timestamp formatting. */
  locale?: string;
}

let {
  activity,
  entry,
  onDismiss,
  onRestore,
  now,
  timeZone,
  locale: localeProp,
}: Props = $props();
const { locale: i18nLocale, t } = useI18n();
const effectiveLocale = $derived(localeProp?.trim() || i18nLocale);

const isDismissed = $derived(Boolean(entry?.dismissed));
const titleText = $derived(entry ? entry.title : (activity?.label ?? ''));
const detailText = $derived(entry ? entry.detail : activity?.message);
const codeText = $derived(entry?.code?.trim() || undefined);
const sourceText = $derived(
  entry?.sourceLabel?.trim() || entry?.source?.trim() || undefined,
);
const contextLabel = $derived(entry?.context?.label?.trim() || undefined);
const contextHref = $derived(
  contextLabel ? safeActivityHref(entry?.context?.href) : undefined,
);
const statusBadge = $derived.by(() => {
  const label = entry?.status?.label?.trim();
  if (!label) return null;
  const rawTone = entry?.status?.tone;
  const tone: ActivityStatusTone =
    rawTone && VALID_TONES.has(rawTone) ? rawTone : 'neutral';
  return { label, tone };
});
const metaText = $derived(entry?.meta?.trim() || undefined);
const jobStatus = $derived(!entry ? activity?.status : undefined);
const rawTimestamp = $derived(
  entry ? entry.occurredAt : (activity?.updatedAt ?? activity?.createdAt),
);
const timeInfo = $derived(
  formatActivityTimestamp(rawTimestamp, {
    locale: effectiveLocale,
    timeZone,
    justNowLabel: t(M['ui.activity_item.just_now']),
    now,
  }),
);
const hasEyebrow = $derived(
  Boolean(
    sourceText ||
      contextLabel ||
      statusBadge ||
      metaText ||
      jobStatus ||
      timeInfo,
  ),
);
const resolvedHref = $derived(
  safeActivityHref(entry ? entry.href : activity?.detailHref),
);
const canCancelJob = $derived(
  Boolean(
    !entry &&
      activity?.cancel &&
      (activity.status === 'queued' || activity.status === 'running'),
  ),
);
const canRestoreEntry = $derived(Boolean(entry && isDismissed && onRestore));
const canDismissEntry = $derived(Boolean(entry && !isDismissed && onDismiss));
const hasActions = $derived(
  Boolean(resolvedHref || canCancelJob || canRestoreEntry || canDismissEntry),
);
</script>

<article
  class="smrt-activity-item"
  class:smrt-activity-item--dismissed={isDismissed}
  data-status={entry ? statusBadge?.tone : activity?.status}
  data-dismissed={isDismissed ? 'true' : undefined}
  data-smrt-component="ActivityItem"
>
  <div class="smrt-activity-item__main" data-smrt-part="body">
    {#if hasEyebrow}
      <div class="smrt-activity-item__eyebrow" data-smrt-part="eyebrow">
        <div class="smrt-activity-item__eyebrow-items">
          {#if sourceText}
            <span class="smrt-activity-item__source" data-smrt-part="source">{sourceText}</span>
          {/if}
          {#if contextLabel}
            {#if contextHref}
              <a
                class="smrt-activity-item__context smrt-activity-item__context--link"
                data-smrt-part="context"
                href={contextHref}
              >{contextLabel}</a>
            {:else}
              <span class="smrt-activity-item__context" data-smrt-part="context">{contextLabel}</span>
            {/if}
          {/if}
          {#if statusBadge}
            <Badge size="sm" variant={statusBadge.tone}>{statusBadge.label}</Badge>
          {/if}
          {#if jobStatus}
            <span class="smrt-activity-item__job-status" data-smrt-part="status">{jobStatus}</span>
          {/if}
          {#if metaText}
            <span class="smrt-activity-item__meta-text" data-smrt-part="meta">{metaText}</span>
          {/if}
        </div>
        {#if timeInfo}
          {#if timeInfo.datetime}
            <time
              class="smrt-activity-item__time"
              data-smrt-part="time"
              datetime={timeInfo.datetime}
              title={timeInfo.title}
            >{timeInfo.label}</time>
          {:else}
            <span class="smrt-activity-item__time" data-smrt-part="time">{timeInfo.label}</span>
          {/if}
        {/if}
      </div>
    {/if}

    <div class="smrt-activity-item__heading" data-smrt-part="heading">
      {#if codeText}
        <code class="smrt-activity-item__code" data-smrt-part="code">{codeText}</code>
      {/if}
      <strong class="smrt-activity-item__title" data-smrt-part="title">{titleText}</strong>
    </div>

    {#if detailText}
      <p class="smrt-activity-item__detail" data-smrt-part="detail">{detailText}</p>
    {/if}

    {#if !entry && typeof activity?.progress === 'number'}
      <progress max="100" value={activity.progress}>
        {Math.round(activity.progress)}%
      </progress>
    {/if}
  </div>

  {#if hasActions}
    <div class="smrt-activity-item__actions" data-smrt-part="actions">
      {#if resolvedHref}
        <Button variant="ghost" size="sm" labelWhitespace="trim" href={resolvedHref}>
          {t(M['ui.activity_item.view'])}
        </Button>
      {/if}
      {#if canRestoreEntry && entry}
        <Button
          variant="ghost"
          size="sm"
          labelWhitespace="trim"
          aria-label={t(M['ui.activity_item.restore_item'], { title: entry.title })}
          onclick={() => void onRestore?.(entry.id)}
        >
          {t(M['ui.activity_item.restore'])}
        </Button>
      {:else if canDismissEntry && entry}
        <Button
          variant="ghost"
          size="sm"
          labelWhitespace="trim"
          class="smrt-activity-item__dismiss"
          aria-label={t(M['ui.activity_item.dismiss_item'], { title: entry.title })}
          title={t(M['ui.activity_item.dismiss_item'], { title: entry.title })}
          onclick={() => void onDismiss?.(entry.id)}
        >
          <span aria-hidden="true">✕</span>
        </Button>
      {/if}
      {#if canCancelJob && activity}
        <Button variant="ghost" size="sm" labelWhitespace="trim" onclick={() => activity.cancel?.()}>
          {t(M['ui.activity_item.cancel'])}
        </Button>
      {/if}
    </div>
  {/if}
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-activity-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) 0;
  }
  .smrt-activity-item--dismissed {
    padding-inline: var(--smrt-spacing-2);
  }
  .smrt-activity-item__main {
    display: grid;
    flex: 1 1 auto;
    gap: var(--smrt-spacing-1);
    min-inline-size: 0;
  }
  .smrt-activity-item__eyebrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
  }
  .smrt-activity-item__eyebrow-items {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
  }
  .smrt-activity-item__source {
    white-space: nowrap;
  }
  .smrt-activity-item__context {
    display: inline-flex;
    align-items: center;
    max-inline-size: 16rem;
    padding: 0 var(--smrt-spacing-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-activity-item__meta-text {
    overflow-wrap: anywhere;
  }
  .smrt-activity-item__time {
    flex-shrink: 0;
    margin-inline-start: auto;
    white-space: nowrap;
  }
  .smrt-activity-item__heading {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
  }
  .smrt-activity-item__code {
    flex-shrink: 0;
    padding: 0 var(--smrt-spacing-1);
    white-space: nowrap;
  }
  .smrt-activity-item__title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-activity-item__detail {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .smrt-activity-item progress {
    width: min(16rem, 100%);
  }
  .smrt-activity-item__actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
    gap: var(--smrt-spacing-1);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-activity-item {
    border-block-end: var(--smrt-hairline);
  }
  .smrt-activity-item:last-child {
    border-block-end: 0;
  }
  .smrt-activity-item--dismissed {
    background: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-activity-item__source {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
    font-weight: var(--smrt-typography-weight-semibold);
  }
  .smrt-activity-item__context {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    border: var(--smrt-hairline);
    border-color: var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full);
    font: var(--smrt-typography-label-medium-font);
    text-decoration: none;
  }
  .smrt-activity-item__context--link {
    color: var(--smrt-color-primary);
  }
  .smrt-activity-item__context--link:hover {
    text-decoration: underline;
  }
  .smrt-activity-item__context--link:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-activity-item__job-status {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size);
    text-transform: uppercase;
  }
  .smrt-activity-item__meta-text,
  .smrt-activity-item__time {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size);
  }
  .smrt-activity-item__time {
    font-variant-numeric: tabular-nums;
  }
  .smrt-activity-item__code {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-sm);
    font-family: var(--smrt-font-family-mono);
    font-size: var(--smrt-typography-label-medium-size);
  }
  .smrt-activity-item__title {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-medium-size);
    font-weight: var(--smrt-typography-weight-semibold);
    line-height: var(--smrt-typography-body-medium-line-height);
  }
  .smrt-activity-item--dismissed .smrt-activity-item__title {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium);
  }
  .smrt-activity-item__detail {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size);
    line-height: var(--smrt-typography-body-medium-line-height);
  }
}
</style>
