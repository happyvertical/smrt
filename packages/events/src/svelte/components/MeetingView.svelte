<script lang="ts">
/**
 * MeetingView Component
 * Displays details for a council meeting with links to agenda, minutes, video
 */

import type { Meeting } from '../types.js';

interface Props {
  meeting: Meeting;
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

<div class="meeting-view">
  <header class="meeting-header">
    <a href={calendarUrl} class="back-link">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Back to Calendar
    </a>

    {#if meeting.council}
      <div class="council-badge">
        <span class="council-icon">{'\u{1F3DB}'}</span>
        {meeting.council.name}
      </div>
    {/if}

    <h1 class="meeting-title">{meeting.name}</h1>

    <div class="meeting-meta">
      <time class="meeting-date">{formattedDate}</time>
      <span class="meeting-time">{formattedTime}</span>
    </div>
  </header>

  <div class="meeting-content">
    {#if hasDocuments}
      <section class="documents-section">
        <h2 class="section-title">Documents & Resources</h2>

        <div class="documents-grid">
          {#if meeting.agendaUrl}
            <a href={meeting.agendaUrl} class="document-card" target="_blank" rel="noopener noreferrer">
              <span class="document-icon">{'\u{1F4CB}'}</span>
              <div class="document-info">
                <span class="document-name">Agenda</span>
                <span class="document-desc">Meeting agenda and items</span>
              </div>
              <span class="document-arrow">{'\u2197'}</span>
            </a>
          {/if}

          {#if meeting.minutesUrl}
            <a href={meeting.minutesUrl} class="document-card" target="_blank" rel="noopener noreferrer">
              <span class="document-icon">{'\u{1F4DD}'}</span>
              <div class="document-info">
                <span class="document-name">Minutes</span>
                <span class="document-desc">Official meeting minutes</span>
              </div>
              <span class="document-arrow">{'\u2197'}</span>
            </a>
          {/if}

          {#if meeting.videoUrl}
            <a href={meeting.videoUrl} class="document-card" target="_blank" rel="noopener noreferrer">
              <span class="document-icon">{'\u{1F3AC}'}</span>
              <div class="document-info">
                <span class="document-name">Video</span>
                <span class="document-desc">Watch the recording</span>
              </div>
              <span class="document-arrow">{'\u2197'}</span>
            </a>
          {/if}

          {#if meeting.highlightsUrl}
            <a href={meeting.highlightsUrl} class="document-card" target="_blank" rel="noopener noreferrer">
              <span class="document-icon">{'\u{2728}'}</span>
              <div class="document-info">
                <span class="document-name">Highlights</span>
                <span class="document-desc">Key decisions summary</span>
              </div>
              <span class="document-arrow">{'\u2197'}</span>
            </a>
          {/if}
        </div>
      </section>
    {:else}
      <div class="empty-state">
        <span class="empty-icon">{'\u{1F4C4}'}</span>
        <p class="empty-text">No documents available yet for this meeting</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .meeting-view {
    --view-bg: var(--color-neutral-white, #ffffff);
    --view-border: var(--color-neutral-gray200, #e5e7eb);
    --header-bg: var(--color-neutral-gray100, #f5f5f5);
    --card-hover: var(--color-neutral-gray100, #f5f5f5);

    background: var(--view-bg);
  }

  .meeting-header {
    padding: var(--spacing-lg, 1.5rem);
    background: var(--header-bg);
    border-bottom: 1px solid var(--view-border);
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs, 0.25rem);
    color: var(--color-primary-main, #1976d2);
    text-decoration: none;
    font-size: var(--font-size-sm, 0.875rem);
    margin-bottom: var(--spacing-md, 1rem);
    transition: color var(--transition-fast, 150ms);
  }

  .back-link:hover {
    color: var(--color-primary-dark, #0d47a1);
  }

  .council-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs, 0.25rem);
    padding: var(--spacing-xs, 0.25rem) var(--spacing-sm, 0.5rem);
    background: var(--view-bg);
    border: 1px solid var(--view-border);
    border-radius: var(--radius-full, 9999px);
    font-size: var(--font-size-sm, 0.875rem);
    color: var(--color-text-secondary, #666);
    margin-bottom: var(--spacing-sm, 0.5rem);
  }

  .council-icon {
    font-size: 14px;
  }

  .meeting-title {
    margin: 0;
    font-size: var(--font-size-2xl, 1.5rem);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--color-text-primary, #333);
    line-height: 1.3;
  }

  .meeting-meta {
    display: flex;
    align-items: center;
    gap: var(--spacing-md, 1rem);
    margin-top: var(--spacing-sm, 0.5rem);
    color: var(--color-text-secondary, #666);
    font-size: var(--font-size-md, 1rem);
  }

  .meeting-date {
    font-weight: var(--font-weight-medium, 500);
  }

  .meeting-time::before {
    content: '\2022';
    margin-right: var(--spacing-md, 1rem);
  }

  .meeting-content {
    padding: var(--spacing-lg, 1.5rem);
  }

  .section-title {
    margin: 0 0 var(--spacing-md, 1rem) 0;
    font-size: var(--font-size-lg, 1.125rem);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--color-text-primary, #333);
  }

  .documents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--spacing-md, 1rem);
  }

  .document-card {
    display: flex;
    align-items: center;
    gap: var(--spacing-md, 1rem);
    padding: var(--spacing-md, 1rem);
    background: var(--view-bg);
    border: 1px solid var(--view-border);
    border-radius: var(--radius-md, 8px);
    text-decoration: none;
    color: var(--color-text-primary, #333);
    transition: all var(--transition-fast, 150ms);
  }

  .document-card:hover {
    background: var(--card-hover);
    border-color: var(--color-neutral-gray300, #d1d5db);
    transform: translateY(-1px);
  }

  .document-card:hover .document-arrow {
    transform: translate(2px, -2px);
  }

  .document-icon {
    font-size: 24px;
    flex-shrink: 0;
  }

  .document-info {
    flex: 1;
    min-width: 0;
  }

  .document-name {
    display: block;
    font-weight: var(--font-weight-medium, 500);
    font-size: var(--font-size-md, 1rem);
  }

  .document-desc {
    display: block;
    font-size: var(--font-size-sm, 0.875rem);
    color: var(--color-text-secondary, #666);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .document-arrow {
    flex-shrink: 0;
    font-size: 16px;
    color: var(--color-text-secondary, #666);
    transition: transform var(--transition-fast, 150ms);
  }

  .empty-state {
    text-align: center;
    padding: var(--spacing-3xl, 4rem) var(--spacing-lg, 1.5rem);
    color: var(--color-text-secondary, #666);
  }

  .empty-icon {
    font-size: 48px;
    display: block;
    margin-bottom: var(--spacing-md, 1rem);
    opacity: 0.5;
  }

  .empty-text {
    margin: 0;
    font-size: var(--font-size-lg, 1.125rem);
  }

  @media (max-width: 640px) {
    .meeting-header {
      padding: var(--spacing-md, 1rem);
    }

    .meeting-title {
      font-size: var(--font-size-xl, 1.25rem);
    }

    .meeting-meta {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--spacing-xs, 0.25rem);
    }

    .meeting-time::before {
      display: none;
    }

    .meeting-content {
      padding: var(--spacing-md, 1rem);
    }

    .documents-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
