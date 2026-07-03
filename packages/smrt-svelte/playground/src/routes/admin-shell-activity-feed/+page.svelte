<script lang="ts">
/**
 * Playground demo for the AdminShell activity feed adapter (#1779).
 *
 * Shows `activityFeed` (from `@happyvertical/smrt-svelte/web`) bridging a
 * `@happyvertical/smrt-web` live collection into the shell's activity registry:
 * as rows appear / change / vanish in the collection, activities start, advance,
 * complete, and disappear in the shell — surfacing in the Focus panel and the
 * activity toasts, with NO shell-specific code beyond the editorial `map`.
 *
 * The backing collection is a real `createSmrtCollection` over an in-memory job
 * definition. To animate the lifecycle from the page, the demo simulates a
 * BACKEND FEED using the engine collection's manual sync-write API
 * (`writeInsert` / `writeUpdate` / `writeDelete`) — which injects rows into the
 * synced store exactly as a real SSE/WebSocket feed would, without any
 * optimistic-mutation round trip. The adapter reconciles those rows into shell
 * activities the same way regardless of what drives the collection.
 */

import { activityFeed } from '@happyvertical/smrt-svelte/web';
import {
  ActivityList,
  ActivityToasts,
  AdminShell,
  AppScopePanel,
  createShellState,
} from '@happyvertical/smrt-svelte/workspace';
import { Button } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type {
  SmrtCrudFetchers,
  SmrtWebCollectionDefinition,
} from '@happyvertical/smrt-web';
import {
  createSmrtCollection,
  getEngineCollection,
} from '@happyvertical/smrt-web';
import { onDestroy } from 'svelte';
import { M } from '../../../../src/i18n/strings.workspace.js';

const { t } = useI18n();

/** The demo's job row shape. */
interface JobRow {
  id: string;
  title: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
}

/**
 * Minimal slice of the engine collection's manual sync-write API — the same
 * calls a real backend feed (SSE/WebSocket) would use to push rows into a
 * `@happyvertical/smrt-web` collection's synced store. Reached via
 * `getEngineCollection` (an advanced bridge) purely to animate this demo.
 */
interface FeedWriter {
  writeInsert(row: JobRow): void;
  writeUpdate(row: Partial<JobRow> & { id: string }): void;
  writeDelete(key: string): void;
}

const jobDefinition: SmrtWebCollectionDefinition<JobRow> = {
  name: 'demo_render_jobs',
  className: 'RenderJob',
  endpoint: '/demo_render_jobs',
  idField: 'id',
  actions: ['list'],
  fields: {
    title: { type: 'text', required: true },
    state: { type: 'text' },
    progress: { type: 'integer' },
  },
};

// In-memory "server" backing the collection's initial load — the feed then
// pushes further changes through the manual sync-write API below.
const fetchers: SmrtCrudFetchers = {
  list: async () => [],
};

const collection = createSmrtCollection<JobRow>(jobDefinition, {
  fetchers,
  staleTimeMs: 60_000,
  initialData: [],
});

// Reach the engine collection's sync-write utils to simulate the backend feed.
const engine = getEngineCollection(collection) as {
  utils: FeedWriter;
};
const feed = engine.utils;

const shell = createShellState({
  settings: { panels: { right: 'expanded' } },
});

// Bridge the live collection into the shell. One editorial map turns each job
// row into a Focus-scope activity; the adapter drives upsert/update/remove.
const handle = activityFeed<JobRow>({
  collection,
  shell,
  map: (row) => ({
    kind: 'render-job',
    scope: 'focus',
    label: `${t(M['ui.activity_feed.job_label'])}: ${row.title}`,
    status: row.state,
    progress: row.progress,
  }),
});

onDestroy(() => handle.dispose());

let nextId = $state(1);
// Mirror of the rows the demo has pushed, shown in the "backing rows" panel.
let rows = $state<JobRow[]>([]);

function syncRowsView() {
  rows = collection.toArray.map((row) => ({ ...row }) as JobRow);
}

function enqueueJob() {
  const seq = nextId;
  nextId += 1;
  const row: JobRow = {
    id: `job-${seq}`,
    title: `#${seq}`,
    state: 'running',
    progress: 0,
  };
  feed.writeInsert(row);
  syncRowsView();
}

function advanceJob() {
  const running = collection.toArray.find((row) => row.state === 'running');
  if (!running) return;
  const progress = Math.min(100, (running.progress ?? 0) + 25);
  feed.writeUpdate({ id: running.id, progress });
  syncRowsView();
}

function completeJob() {
  const running = collection.toArray.find((row) => row.state === 'running');
  if (!running) return;
  feed.writeUpdate({ id: running.id, state: 'completed', progress: 100 });
  syncRowsView();
}

function failJob() {
  const running = collection.toArray.find((row) => row.state === 'running');
  if (!running) return;
  feed.writeUpdate({ id: running.id, state: 'failed' });
  syncRowsView();
}

function clearFinished() {
  for (const row of collection.toArray) {
    if (row.state === 'completed' || row.state === 'failed') {
      feed.writeDelete(row.id);
    }
  }
  syncRowsView();
}
</script>

<AdminShell
  title="SMRT AdminShell"
  subtitle={t(M['ui.activity_feed.title'])}
  state={shell}
>
  {#snippet appPanel()}
    <AppScopePanel
      appName="SMRT Playground"
      tenantName="Demo tenant"
      environment="local"
    />
  {/snippet}

  {#snippet focusPanel()}
    <section class="feed-focus">
      <header>
        <h2>{t(M['ui.activity_feed.title'])}</h2>
      </header>
      <ActivityList filter={{ kind: 'render-job' }} hideWhenEmpty />
    </section>
  {/snippet}

  <section class="feed-demo">
    <header>
      <h1>{t(M['ui.activity_feed.title'])}</h1>
      <p>{t(M['ui.activity_feed.description'])}</p>
      <div class="feed-actions">
        <Button onclick={enqueueJob}>{t(M['ui.activity_feed.enqueue_job'])}</Button>
        <Button variant="secondary" onclick={advanceJob}>
          {t(M['ui.activity_feed.advance_job'])}
        </Button>
        <Button variant="secondary" onclick={completeJob}>
          {t(M['ui.activity_feed.complete_job'])}
        </Button>
        <Button variant="secondary" onclick={failJob}>
          {t(M['ui.activity_feed.fail_job'])}
        </Button>
        <Button variant="secondary" onclick={clearFinished}>
          {t(M['ui.activity_feed.clear_finished'])}
        </Button>
      </div>
    </header>

    <section class="feed-rows">
      <h2>{t(M['ui.activity_feed.rows_heading'])}</h2>
      {#if rows.length === 0}
        <p class="feed-empty">{t(M['ui.activity_feed.no_rows'])}</p>
      {:else}
        <ul>
          {#each rows as row (row.id)}
            <li>
              <span class="feed-row-title">{row.title}</span>
              <span class="feed-row-state" data-state={row.state}>{row.state}</span>
              <span class="feed-row-progress">{row.progress}%</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </section>

  <ActivityToasts />
</AdminShell>

<style>
  :global(body) {
    margin: 0;
  }

  .feed-demo {
    display: grid;
    gap: var(--smrt-spacing-6);
    min-block-size: 100%;
    padding: var(--smrt-spacing-8);
    background: var(--smrt-color-surface);
  }

  .feed-demo header,
  .feed-focus {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .feed-demo h1,
  .feed-demo p,
  .feed-focus h2 {
    margin: 0;
  }

  .feed-demo p {
    color: var(--smrt-color-on-surface-variant);
  }

  .feed-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  .feed-rows {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .feed-rows h2 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size);
  }

  .feed-rows ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--smrt-spacing-2);
  }

  .feed-rows li {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    background: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-sm);
  }

  .feed-row-title {
    font-weight: var(--smrt-typography-weight-medium);
    color: var(--smrt-color-on-surface);
  }

  .feed-row-state {
    color: var(--smrt-color-on-surface-variant);
  }

  .feed-row-progress {
    margin-inline-start: auto;
    color: var(--smrt-color-on-surface-variant);
  }

  .feed-empty {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
