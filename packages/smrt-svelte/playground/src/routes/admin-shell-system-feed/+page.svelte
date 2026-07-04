<script lang="ts">
import {
  type ShellStatusChip,
  type ShellSystemPanel,
  SystemScopePanel,
  SystemStatusChips,
} from '@happyvertical/smrt-svelte/workspace';
import { systemFeed } from '@happyvertical/smrt-svelte/workspace/live';
import { Button } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onDestroy } from 'svelte';
import { M } from '../../../../src/i18n/strings.workspace.js';

const { t } = useI18n();

// ---------------------------------------------------------------------------
// Fixture "server": stands in for a `+server.ts` that reads `_smrt_*` via the
// smrt-jobs query API. Each call returns a fresh snapshot that drifts over time
// (jobs progress queued -> running -> completed, a schedule fires, dispatch
// drains) so the polled feed visibly updates. A demo toggle can force the next
// call to reject, exercising the helper's error tolerance.
// ---------------------------------------------------------------------------

interface SystemStatus {
  generatedAt: string;
  workers: number;
  counts: { queued: number; running: number; failed: number };
  jobs: Array<{
    id: string;
    label: string;
    status: string;
    detail?: string;
  }>;
  schedules: Array<{
    id: string;
    label: string;
    status: string;
    detail?: string;
  }>;
  dispatch: Array<{
    id: string;
    label: string;
    status: string;
    detail?: string;
  }>;
}

let calls = $state(0);
let failNext = false;

function buildStatus(): SystemStatus {
  calls += 1;
  // Deterministic-ish drift keyed off the call count.
  const running = 1 + (calls % 3);
  const queued = Math.max(0, 3 - (calls % 4));
  const failed = calls % 5 === 0 ? 1 : 0;

  const jobs = [
    {
      id: 'job-knowledge',
      label: 'KnowledgeBase.rebuild',
      status: calls % 3 === 0 ? 'completed' : 'running',
      detail: `attempt ${1 + (calls % 3)}`,
    },
    {
      id: 'job-thumbs',
      label: 'Asset.generateThumbnails',
      status: queued > 0 ? 'pending' : 'running',
      detail: queued > 0 ? `${queued} queued` : 'processing',
    },
  ];
  if (failed) {
    jobs.push({
      id: 'job-import',
      label: 'Feed.import',
      status: 'failed',
      detail: 'connection reset',
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    workers: 2,
    counts: { queued, running, failed },
    jobs,
    schedules: [
      {
        id: 'sched-nightly',
        label: 'nightly-digest',
        status: calls % 6 < 3 ? 'idle' : 'running',
        detail: 'cron 0 3 * * *',
      },
    ],
    dispatch: [
      {
        id: 'dispatch-encode',
        label: 'agent.video.encode',
        status: calls % 2 === 0 ? 'pending' : 'delivered',
        detail: 'subscriber: video-worker',
      },
    ],
  };
}

async function fixtureFetch(signal: AbortSignal): Promise<SystemStatus> {
  // Simulate a short network round-trip so aborts/superseding are realistic.
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, 120);
    signal.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  if (failNext) {
    failNext = false;
    throw new Error('fixture: forced fetch failure');
  }
  return buildStatus();
}

function mapStatus(status: SystemStatus): {
  panels: ShellSystemPanel[];
  chips: ShellStatusChip[];
} {
  const chips: ShellStatusChip[] = [
    {
      id: 'workers',
      label: t(M['ui.system_feed.chip_workers']),
      value: status.workers,
      tone: 'info',
    },
    {
      id: 'running',
      label: t(M['ui.system_feed.chip_running']),
      value: status.counts.running,
      tone: 'success',
    },
    {
      id: 'queued',
      label: t(M['ui.system_feed.chip_queued']),
      value: status.counts.queued,
      tone: status.counts.queued > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'failed',
      label: t(M['ui.system_feed.chip_failed']),
      value: status.counts.failed,
      tone: status.counts.failed > 0 ? 'error' : 'neutral',
    },
  ];

  const panels: ShellSystemPanel[] = [
    {
      id: 'jobs',
      label: t(M['ui.system_feed.jobs_panel']),
      items: status.jobs.map((job) => ({
        id: job.id,
        label: job.label,
        status: job.status,
        detail: job.detail,
        updatedAt: status.generatedAt,
      })),
    },
    {
      id: 'schedules',
      label: t(M['ui.system_feed.schedules_panel']),
      items: status.schedules.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        detail: row.detail,
        updatedAt: status.generatedAt,
      })),
    },
    {
      id: 'dispatch',
      label: t(M['ui.system_feed.dispatch_panel']),
      items: status.dispatch.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        detail: row.detail,
        updatedAt: status.generatedAt,
      })),
    },
  ];

  return { panels, chips };
}

const feed = systemFeed<SystemStatus>({
  fetch: fixtureFetch,
  intervalMs: 2000,
  map: mapStatus,
});

onDestroy(feed.dispose);
</script>

<main class="system-feed-demo">
  <header>
    <h1>{t(M['ui.system_feed.title'])}</h1>
    <p>{t(M['ui.system_feed.description'])}</p>
    <div class="controls">
      {#if feed.running}
        <Button size="sm" onclick={() => feed.stop()}>
          {t(M['ui.system_feed.pause'])}
        </Button>
      {:else}
        <Button size="sm" onclick={() => feed.start()}>
          {t(M['ui.system_feed.resume'])}
        </Button>
      {/if}
      <Button variant="secondary" size="sm" onclick={() => feed.refresh()}>
        {t(M['ui.system_feed.refresh'])}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onclick={() => {
          failNext = true;
          feed.refresh();
        }}
      >
        {t(M['ui.system_feed.fail_next'])}
      </Button>
    </div>
    <dl class="feed-meta">
      <div>
        <dt>{t(M['ui.system_feed.status_label'])}</dt>
        <dd>{feed.status}</dd>
      </div>
      <div>
        <dt>{t(M['ui.system_feed.tick_label'])}</dt>
        <dd>{calls}</dd>
      </div>
      {#if feed.error}
        <div>
          <dt>{t(M['ui.system_feed.error_label'])}</dt>
          <dd>{String(feed.error)}</dd>
        </div>
      {/if}
    </dl>
  </header>

  <section class="feed-surface">
    <SystemStatusChips chips={feed.chips} />
    <SystemScopePanel panels={feed.panels} showActivities={false} />
  </section>
</main>

<style>
  .system-feed-demo {
    display: grid;
    gap: var(--smrt-spacing-6);
    max-inline-size: 48rem;
    margin: 0 auto;
    padding: var(--smrt-spacing-8);
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface);
  }

  .system-feed-demo header,
  .feed-surface {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .system-feed-demo h1,
  .system-feed-demo p {
    margin: 0;
  }

  .system-feed-demo p {
    color: var(--smrt-color-on-surface-variant);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  .feed-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2) var(--smrt-spacing-6);
    margin: 0;
  }

  .feed-meta div {
    display: flex;
    gap: var(--smrt-spacing-2);
    align-items: baseline;
  }

  .feed-meta dt {
    color: var(--smrt-color-on-surface-variant);
  }

  .feed-meta dd {
    margin: 0;
    font-family: var(--smrt-font-family-mono);
  }
</style>
