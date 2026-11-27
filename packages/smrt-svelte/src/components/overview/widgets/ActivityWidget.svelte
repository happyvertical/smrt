<script lang="ts">
/**
 * Activity overview widget (#5125): renders authorized workspace activity rows
 * via `ActivityList`, including optional enriched metadata, source filters, and
 * interactive dismissal callbacks. Treats `data` as untrusted shape.
 */
import ActivityList from '../../activity/ActivityList.svelte';
import type {
  ActivityListEntry,
  ActivityStatusTone,
} from '../../activity/types.js';
import type { WidgetComponentProps } from '../types.js';
import { type ActivityWidgetData, isRecord } from './data.js';

let {
  data,
  options,
  locale: gridLocale,
  now: gridNow,
  timeZone: gridTimeZone,
}: WidgetComponentProps<ActivityWidgetData> = $props();

const MAX_ENTRIES = 200;
const VALID_TONES = new Set<ActivityStatusTone>([
  'neutral',
  'primary',
  'success',
  'warning',
  'error',
]);

function isTone(value: unknown): value is ActivityStatusTone {
  return (
    typeof value === 'string' && VALID_TONES.has(value as ActivityStatusTone)
  );
}

const limit = $derived(
  typeof options?.limit === 'number' &&
    Number.isInteger(options.limit) &&
    options.limit > 0
    ? Math.min(options.limit, MAX_ENTRIES)
    : MAX_ENTRIES,
);

const entries = $derived.by((): ActivityListEntry[] => {
  if (!isRecord(data) || !Array.isArray(data.entries)) return [];
  const reservedIds = new Set<string>();
  for (const item of data.entries) {
    if (
      isRecord(item) &&
      typeof item.title === 'string' &&
      typeof item.id === 'string' &&
      item.id
    ) {
      reservedIds.add(item.id);
    }
  }
  const seenIds = new Set<string>();
  let fallbackSeq = 0;
  const out: ActivityListEntry[] = [];
  for (const item of data.entries) {
    if (out.length >= limit) break;
    if (!isRecord(item) || typeof item.title !== 'string') continue;
    let id: string;
    if (typeof item.id === 'string' && item.id) {
      if (seenIds.has(item.id)) continue;
      id = item.id;
    } else {
      while (
        reservedIds.has(String(fallbackSeq)) ||
        seenIds.has(String(fallbackSeq))
      ) {
        fallbackSeq += 1;
      }
      id = String(fallbackSeq);
      fallbackSeq += 1;
    }
    seenIds.add(id);
    const context =
      isRecord(item.context) && typeof item.context.label === 'string'
        ? {
            label: item.context.label,
            href:
              typeof item.context.href === 'string' ? item.context.href : null,
          }
        : null;
    const status =
      isRecord(item.status) && typeof item.status.label === 'string'
        ? {
            label: item.status.label,
            ...(isTone(item.status.tone) ? { tone: item.status.tone } : {}),
          }
        : null;
    out.push({
      id,
      title: item.title,
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
      href: typeof item.href === 'string' ? item.href : null,
      ...(typeof item.source === 'string' ? { source: item.source } : {}),
      ...(typeof item.sourceLabel === 'string'
        ? { sourceLabel: item.sourceLabel }
        : {}),
      ...(typeof item.code === 'string' ? { code: item.code } : {}),
      ...(context ? { context } : {}),
      ...(status ? { status } : {}),
      ...(typeof item.meta === 'string' ? { meta: item.meta } : {}),
      ...(typeof item.dismissed === 'boolean'
        ? { dismissed: item.dismissed }
        : {}),
    });
  }
  return out;
});

const emptyLabel = $derived(
  isRecord(data) && typeof data.emptyLabel === 'string'
    ? data.emptyLabel
    : undefined,
);
const caughtUpLabel = $derived(
  isRecord(data) && typeof data.caughtUpLabel === 'string'
    ? data.caughtUpLabel
    : undefined,
);
const sourceFilter = $derived(
  isRecord(data) && typeof data.sourceFilter === 'boolean'
    ? data.sourceFilter
    : undefined,
);
const onDismiss = $derived(
  isRecord(data) && typeof data.onDismiss === 'function'
    ? (data.onDismiss as ActivityWidgetData['onDismiss'])
    : undefined,
);
const onDismissMany = $derived(
  isRecord(data) && typeof data.onDismissMany === 'function'
    ? (data.onDismissMany as ActivityWidgetData['onDismissMany'])
    : undefined,
);
const onRestore = $derived(
  isRecord(data) && typeof data.onRestore === 'function'
    ? (data.onRestore as ActivityWidgetData['onRestore'])
    : undefined,
);
const canUndo = $derived(
  isRecord(data) && typeof data.canUndo === 'boolean'
    ? data.canUndo
    : undefined,
);
const onUndo = $derived(
  isRecord(data) && typeof data.onUndo === 'function'
    ? (data.onUndo as ActivityWidgetData['onUndo'])
    : undefined,
);
const dismissedCount = $derived(
  isRecord(data) &&
    typeof data.dismissedCount === 'number' &&
    Number.isFinite(data.dismissedCount)
    ? data.dismissedCount
    : undefined,
);
const showDismissed = $derived(
  isRecord(data) && typeof data.showDismissed === 'boolean'
    ? data.showDismissed
    : undefined,
);
const onToggleShowDismissed = $derived(
  isRecord(data) && typeof data.onToggleShowDismissed === 'function'
    ? (data.onToggleShowDismissed as ActivityWidgetData['onToggleShowDismissed'])
    : undefined,
);
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

function isValidEpochMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DATE_EPOCH_MS
  );
}

const now = $derived(
  isRecord(data) && isValidEpochMs(data.now)
    ? data.now
    : isValidEpochMs(gridNow)
      ? gridNow
      : undefined,
);
const timeZone = $derived(
  isRecord(data) && typeof data.timeZone === 'string' && data.timeZone.trim()
    ? data.timeZone.trim()
    : typeof gridTimeZone === 'string' && gridTimeZone.trim()
      ? gridTimeZone.trim()
      : undefined,
);
const locale = $derived(
  isRecord(data) && typeof data.locale === 'string' && data.locale.trim()
    ? data.locale.trim()
    : typeof gridLocale === 'string' && gridLocale.trim()
      ? gridLocale.trim()
      : undefined,
);
</script>

<div class="smrt-activity-widget__root" data-smrt-component="ActivityWidget">
  <ActivityList
    {entries}
    {emptyLabel}
    {caughtUpLabel}
    {sourceFilter}
    {onDismiss}
    {onDismissMany}
    {onRestore}
    {canUndo}
    {onUndo}
    {dismissedCount}
    {showDismissed}
    {onToggleShowDismissed}
    {now}
    {timeZone}
    {locale}
  />
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-activity-widget__root {
    min-inline-size: 0;
  }
}

@layer smrt.theme {
}
</style>
