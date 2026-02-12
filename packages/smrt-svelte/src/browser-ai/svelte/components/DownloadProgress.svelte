<script lang="ts">
import type { DownloadProgressInfo } from '../../index.js';

export interface Props {
  /** Progress data */
  progress: DownloadProgressInfo | null;
  /** Label to show above progress bar */
  label?: string;
  /** Show percentage text */
  showPercent?: boolean;
  /** Show bytes downloaded */
  showBytes?: boolean;
}

const {
  progress,
  label = 'Loading...',
  showPercent = true,
  showBytes = false,
}: Props = $props();

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
</script>

<div class="download-progress">
  <div class="label">
    <span>{label}</span>
    {#if showPercent && progress}
      <span class="percent">{progress.percent}%</span>
    {/if}
  </div>

  <div class="progress-bar">
    <div
      class="progress-fill"
      style:width="{progress?.percent ?? 0}%"
      class:indeterminate={!progress || progress.state === 'idle'}
    ></div>
  </div>

  {#if showBytes && progress && progress.bytesTotal > 0}
    <div class="bytes">
      {formatBytes(progress.bytesLoaded)} / {formatBytes(progress.bytesTotal)}
    </div>
  {/if}

  {#if progress?.currentFile}
    <div class="current-file">{progress.currentFile}</div>
  {/if}

  {#if progress?.state === 'error'}
    <div class="error">{progress.error}</div>
  {/if}
</div>

<style>
  .download-progress {
    width: 100%;
    padding: var(--smrt-spacing-md, 12px);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-radius: var(--smrt-radius-medium, 8px);
  }

  .label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    margin-bottom: var(--smrt-spacing-sm, 8px);
  }

  .percent {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary, #005ac1);
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-small, 4px);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--smrt-color-primary, #005ac1), var(--smrt-color-primary-container, #d6e3ff));
    border-radius: var(--smrt-radius-small, 4px);
    transition: width var(--smrt-duration-medium1, 300ms) var(--smrt-easing-standard, ease);
  }

  .progress-fill.indeterminate {
    width: 30% !important;
    animation: indeterminate 1.5s infinite linear;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }

  .bytes {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    margin-top: 6px;
    text-align: center;
  }

  .current-file {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-outline, #74777f);
    margin-top: 4px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .error {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-fill {
      transition: none;
    }
    
    .progress-fill.indeterminate {
      animation: none;
    }
  }
</style>
