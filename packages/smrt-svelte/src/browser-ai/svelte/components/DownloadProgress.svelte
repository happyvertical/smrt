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

<div class="smrt-download-progress__root" data-smrt-component="DownloadProgress">
  <div class="smrt-download-progress__label" data-smrt-part="label">
    <span>{label}</span>
    {#if showPercent && progress}
      <span class="smrt-download-progress__percent" data-smrt-part="value">{progress.percent}%</span>
    {/if}
  </div>

  <div class="smrt-download-progress__progress-bar" data-smrt-part="progress">
    <div
      class="smrt-download-progress__progress-fill"
      style:width={progress && progress.state !== 'idle' ? `${progress.percent ?? 0}%` : undefined}
      class:smrt-download-progress__indeterminate={!progress || progress.state === 'idle'} data-smrt-part="indicator"
    ></div>
  </div>

  {#if showBytes && progress && progress.bytesTotal > 0}
    <div class="smrt-download-progress__bytes" data-smrt-part="meta">
      {formatBytes(progress.bytesLoaded)} / {formatBytes(progress.bytesTotal)}
    </div>
  {/if}

  {#if progress?.currentFile}
    <div class="smrt-download-progress__current-file" data-smrt-part="meta">{progress.currentFile}</div>
  {/if}

  {#if progress?.state === 'error'}
    <div class="smrt-download-progress__error" data-smrt-part="error">{progress.error}</div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-download-progress__root {
    width: 100%;
    padding: var(--smrt-spacing-md);
  }
  .smrt-download-progress__label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--smrt-spacing-sm);
  }
  .smrt-download-progress__progress-bar {
    width: 100%;
    height: 8px;
    overflow: hidden;
  }
  .smrt-download-progress__progress-fill {
    height: 100%;
  }
  .smrt-download-progress__progress-fill.smrt-download-progress__indeterminate {
    width: 30%;
  }
  .smrt-download-progress__bytes {
    margin-top: var(--smrt-spacing-2);
  }
  .smrt-download-progress__current-file {
    margin-top: var(--smrt-spacing-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-download-progress__error {
    margin-top: var(--smrt-spacing-2);
  }
}

@layer smrt.theme {
  .smrt-download-progress__root {
    background: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-medium);
  }
  .smrt-download-progress__label {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-download-progress__percent {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary);
  }
  .smrt-download-progress__progress-bar {
    background: var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-small);
  }
  .smrt-download-progress__progress-fill {
    background: linear-gradient(90deg, var(--smrt-color-primary), var(--smrt-color-primary-container));
    border-radius: var(--smrt-radius-small);
    transition: width var(--smrt-duration-medium1, 300ms) var(--smrt-easing-standard, ease);
  }
  .smrt-download-progress__progress-fill.smrt-download-progress__indeterminate {
    animation: indeterminate 1.5s infinite linear;
  }
  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }
  .smrt-download-progress__bytes {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-align: center;
  }
  .smrt-download-progress__current-file {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-outline);
    text-align: center;
  }
  .smrt-download-progress__error {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-error);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-download-progress__progress-fill {
      transition: none;
    }
    .smrt-download-progress__progress-fill.smrt-download-progress__indeterminate {
      animation: none;
    }
  }
}

</style>
