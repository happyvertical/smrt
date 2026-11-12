<script lang="ts">
/**
 * MeetingView Component
 * Displays details for a council meeting with links to agenda, minutes, video
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { Meeting } from '../types.js';

const { t } = useI18n();

interface Props {
  /** The meeting to display. */
  meeting: Meeting;
  /** URL to navigate to when clicking the back link. */
  calendarUrl?: string;
}

const { meeting, calendarUrl = '/events' }: Props = $props();

// Format full date
const formattedDate = $derived(
  new Date(meeting.startDate).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
);

// Format time
const formattedTime = $derived(
  new Date(meeting.startDate).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }),
);

// Check if meeting has any documents
const hasDocuments = $derived(
  meeting.agendaUrl ||
    meeting.minutesUrl ||
    meeting.videoUrl ||
    meeting.highlightsUrl,
);
</script>

<div class="smrt-meeting-view__root" data-smrt-component="MeetingView">
  <header class="smrt-meeting-view__header" data-smrt-part="header">
    <a href={calendarUrl} class="smrt-meeting-view__back" data-smrt-part="back">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      {t(M['events.meeting_view.back_to_calendar'])}
    </a>

    {#if meeting.council}
      <div class="smrt-meeting-view__badge" data-smrt-part="badge">
        <span class="smrt-meeting-view__badge-icon" data-smrt-part="icon">{'\u{1F3DB}'}</span>
        {meeting.council.name}
      </div>
    {/if}

    <h1 class="smrt-meeting-view__title" data-smrt-part="title">{meeting.name}</h1>

    <div class="smrt-meeting-view__meta" data-smrt-part="meta">
      <time class="smrt-meeting-view__date" data-smrt-part="time">{formattedDate}</time>
      <span class="smrt-meeting-view__time" data-smrt-part="time">{formattedTime}</span>
    </div>
  </header>

  <div class="smrt-meeting-view__body" data-smrt-part="body">
    {#if hasDocuments}
      <section class="smrt-meeting-view__documents" data-smrt-part="list">
        <h2 class="smrt-meeting-view__heading" data-smrt-part="title">{t(M['events.meeting_view.documents_and_resources'])}</h2>

        <div class="smrt-meeting-view__grid" data-smrt-part="list">
          {#if meeting.agendaUrl}
            <a href={meeting.agendaUrl} class="smrt-meeting-view__card" data-smrt-part="body" target="_blank" rel="noopener noreferrer">
              <span class="smrt-meeting-view__card-icon" data-smrt-part="icon">{'\u{1F4CB}'}</span>
              <div class="smrt-meeting-view__card-info" data-smrt-part="description">
                <span class="smrt-meeting-view__card-name" data-smrt-part="title">Agenda</span>
                <span class="smrt-meeting-view__card-desc" data-smrt-part="description">{t(M['events.meeting_view.agenda_desc'])}</span>
              </div>
              <span class="smrt-meeting-view__card-arrow" data-smrt-part="icon">{'\u2197'}</span>
            </a>
          {/if}

          {#if meeting.minutesUrl}
            <a href={meeting.minutesUrl} class="smrt-meeting-view__card" data-smrt-part="body" target="_blank" rel="noopener noreferrer">
              <span class="smrt-meeting-view__card-icon" data-smrt-part="icon">{'\u{1F4DD}'}</span>
              <div class="smrt-meeting-view__card-info" data-smrt-part="description">
                <span class="smrt-meeting-view__card-name" data-smrt-part="title">Minutes</span>
                <span class="smrt-meeting-view__card-desc" data-smrt-part="description">{t(M['events.meeting_view.minutes_desc'])}</span>
              </div>
              <span class="smrt-meeting-view__card-arrow" data-smrt-part="icon">{'\u2197'}</span>
            </a>
          {/if}

          {#if meeting.videoUrl}
            <a href={meeting.videoUrl} class="smrt-meeting-view__card" data-smrt-part="body" target="_blank" rel="noopener noreferrer">
              <span class="smrt-meeting-view__card-icon" data-smrt-part="icon">{'\u{1F3AC}'}</span>
              <div class="smrt-meeting-view__card-info" data-smrt-part="description">
                <span class="smrt-meeting-view__card-name" data-smrt-part="title">Video</span>
                <span class="smrt-meeting-view__card-desc" data-smrt-part="description">{t(M['events.meeting_view.video_desc'])}</span>
              </div>
              <span class="smrt-meeting-view__card-arrow" data-smrt-part="icon">{'\u2197'}</span>
            </a>
          {/if}

          {#if meeting.highlightsUrl}
            <a href={meeting.highlightsUrl} class="smrt-meeting-view__card" data-smrt-part="body" target="_blank" rel="noopener noreferrer">
              <span class="smrt-meeting-view__card-icon" data-smrt-part="icon">{'\u{2728}'}</span>
              <div class="smrt-meeting-view__card-info" data-smrt-part="description">
                <span class="smrt-meeting-view__card-name" data-smrt-part="title">Highlights</span>
                <span class="smrt-meeting-view__card-desc" data-smrt-part="description">{t(M['events.meeting_view.highlights_desc'])}</span>
              </div>
              <span class="smrt-meeting-view__card-arrow" data-smrt-part="icon">{'\u2197'}</span>
            </a>
          {/if}
        </div>
      </section>
    {:else}
      <div class="smrt-meeting-view__empty" data-smrt-part="empty">
        <span class="smrt-meeting-view__empty-icon" data-smrt-part="icon">{'\u{1F4C4}'}</span>
        <p class="smrt-meeting-view__empty-text" data-smrt-part="message">{t(M['events.meeting_view.no_documents'])}</p>
      </div>
    {/if}
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-meeting-view__header {
    padding: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-meeting-view__back {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-xs, 0.25rem);
    margin-bottom: var(--smrt-spacing-md, 1rem);
  }
  .smrt-meeting-view__badge {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-xs, 0.25rem);
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-sm, 0.5rem);
    margin-bottom: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-meeting-view__title {
    margin: 0;
  }
  .smrt-meeting-view__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-md, 1rem);
    margin-top: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-meeting-view__time::before {
    margin-right: var(--smrt-spacing-md, 1rem);
  }
  .smrt-meeting-view__body {
    padding: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-meeting-view__heading {
    margin: 0 0 var(--smrt-spacing-md, 1rem) 0;
  }
  .smrt-meeting-view__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-meeting-view__card {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-md, 1rem);
    padding: var(--smrt-spacing-md, 1rem);
  }
  .smrt-meeting-view__card-icon {
    flex-shrink: 0;
  }
  .smrt-meeting-view__card-info {
    flex: 1;
    min-width: 0;
  }
  .smrt-meeting-view__card-name {
    display: block;
  }
  .smrt-meeting-view__card-desc {
    display: block;
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-meeting-view__card-arrow {
    flex-shrink: 0;
  }
  .smrt-meeting-view__empty {
    padding: var(--smrt-spacing-3xl, 4rem) var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-meeting-view__empty-icon {
    display: block;
    margin-bottom: var(--smrt-spacing-md, 1rem);
  }
  .smrt-meeting-view__empty-text {
    margin: 0;
  }
  @media (max-width: 640px) {
    .smrt-meeting-view__header {
      padding: var(--smrt-spacing-md, 1rem);
    }
    .smrt-meeting-view__meta {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--smrt-spacing-xs, 0.25rem);
    }
    .smrt-meeting-view__time::before {
      display: none;
    }
    .smrt-meeting-view__body {
      padding: var(--smrt-spacing-md, 1rem);
    }
    .smrt-meeting-view__grid {
      grid-template-columns: 1fr;
    }
  }
  .smrt-meeting-view__time::before {
    content: '\2022';
  }
}

@layer smrt.theme {
  .smrt-meeting-view__root {
    --smrt-meeting-view-bg: var(--smrt-color-surface);
    --smrt-meeting-view-border: var(--smrt-color-surface-container-high);
    --smrt-meeting-view-header-bg: var(--smrt-color-surface-variant);
    --smrt-meeting-view-card-hover: var(--smrt-color-surface-variant);
    background: var(--smrt-meeting-view-bg);
  }
  .smrt-meeting-view__header {
    background: var(--smrt-meeting-view-header-bg);
    border-bottom: 1px solid var(--smrt-meeting-view-border);
  }
  .smrt-meeting-view__back {
    color: var(--smrt-color-primary);
    text-decoration: none;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    transition: color var(--smrt-duration-fast, 150ms);
  }
  .smrt-meeting-view__back:hover {
    color: var(--smrt-color-primary);
  }
  .smrt-meeting-view__badge {
    background: var(--smrt-meeting-view-bg);
    border: 1px solid var(--smrt-meeting-view-border);
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-meeting-view__badge-icon {
    font-size: var(--smrt-typography-label-large-size);
  }
  .smrt-meeting-view__title {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-headline-small-line-height, 1.3);
  }
  .smrt-meeting-view__meta {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-meeting-view__date {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-meeting-view__heading {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-meeting-view__card {
    background: var(--smrt-meeting-view-bg);
    border: 1px solid var(--smrt-meeting-view-border);
    border-radius: var(--smrt-radius-md);
    text-decoration: none;
    color: var(--smrt-color-on-surface);
    transition: all var(--smrt-duration-fast, 150ms);
  }
  .smrt-meeting-view__card:hover {
    background: var(--smrt-meeting-view-card-hover);
    border-color: var(--smrt-hairline-color);
    transform: translateY(-1px);
  }
  .smrt-meeting-view__card:hover .smrt-meeting-view__card-arrow {
    transform: translate(2px, -2px);
  }
  .smrt-meeting-view__card-icon {
    font-size: var(--smrt-typography-headline-small-size);
  }
  .smrt-meeting-view__card-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-meeting-view__card-desc {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-meeting-view__card-arrow {
    font-size: var(--smrt-typography-body-large-size);
    color: var(--smrt-color-on-surface-variant);
    transition: transform var(--smrt-duration-fast, 150ms);
  }
  .smrt-meeting-view__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-meeting-view__empty-icon {
    font-size: var(--smrt-typography-display-medium-size);
    opacity: 0.5;
  }
  .smrt-meeting-view__empty-text {
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
  }
  @media (max-width: 640px) {
    .smrt-meeting-view__title {
      font-size: var(--smrt-typography-title-large-size, 1.25rem);
    }
  }
}

</style>
