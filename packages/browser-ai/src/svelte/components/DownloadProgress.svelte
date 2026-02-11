<script lang="ts">
import type { DownloadProgress } from '@happyvertical/browser-ai';

export interface Props {
  /** Progress data */
  progress: DownloadProgress | null;
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
    padding: 12px;
    background: #f9fafb;
    border-radius: 8px;
  }

  .label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.875rem;
    color: #374151;
    margin-bottom: 8px;
  }

  .percent {
    font-weight: 600;
    color: #3b82f6;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: #e5e7eb;
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #60a5fa);
    border-radius: 4px;
    transition: width 0.3s ease;
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
    font-size: 0.75rem;
    color: #6b7280;
    margin-top: 6px;
    text-align: center;
  }

  .current-file {
    font-size: 0.75rem;
    color: #9ca3af;
    margin-top: 4px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .error {
    font-size: 0.75rem;
    color: #ef4444;
    margin-top: 6px;
  }
</style>
