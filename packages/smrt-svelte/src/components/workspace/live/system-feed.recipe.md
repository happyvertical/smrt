# Recipe: live system-scope data with `systemFeed`

The AdminShell **system scope** (the bottom edge) shows operational data — jobs,
schedules, dispatch, worker liveness. That data lives in the `_smrt_*` **system
tables**, which are intentionally outside the reactive path used for tenant/app
data:

- The core change-feed **skips** every `_smrt_*` table
  (`packages/core/src/change-feed.ts`).
- `smrt-web` does **not** expose these as collections.

So the system scope is not fed by `liveCollection()`. Instead the **app owns a
status endpoint** that reads `_smrt_*` on the server, and the browser **polls**
it with `systemFeed` from `@happyvertical/smrt-svelte/workspace/live`. This
subpath is transport-light — it pulls no `smrt-web` / TanStack dependency.

## 1. Server: expose a jobs-status endpoint

Read the system tables through the `@happyvertical/smrt-jobs` query API
(`SmrtJobCollection`, `SmrtWorkerCollection`, …) — never hand-write SQL against
`_smrt_*`. A SvelteKit `+server.ts` is shown; any framework's request handler
works the same way.

```ts
// src/routes/admin/system/status/+server.ts
import { json } from '@sveltejs/kit';
import { getDatabase } from '@happyvertical/sql';
import { SmrtJobCollection, SmrtWorkerCollection } from '@happyvertical/smrt-jobs';

export async function GET() {
  const db = await getDatabase(/* your app's connection options */);
  const jobs = await SmrtJobCollection.create({ db });
  const workers = await SmrtWorkerCollection.create({ db });

  // Collections read the `_smrt_*` system tables for you.
  const recent = await jobs.list({ orderBy: 'created_at DESC', limit: 20 });
  const live = await workers.list({ limit: 50 });

  const counts = { queued: 0, running: 0, failed: 0 };
  for (const job of recent) {
    if (job.status === 'pending') counts.queued += 1;
    else if (job.status === 'running') counts.running += 1;
    else if (job.status === 'failed') counts.failed += 1;
  }

  return json({
    generatedAt: new Date().toISOString(),
    counts,
    workers: live.length,
    // SmrtJob is a method-dispatch row: `queue` / `objectType` / `method` /
    // `status` / `lastError` — there is no free-text "name" column, so build a
    // label from the fields that exist.
    jobs: recent.map((job) => ({
      id: job.id,
      label: `${job.objectType}.${job.method}`,
      queue: job.queue,
      status: job.status,
      detail: job.lastError ?? undefined,
      updatedAt: job.updatedAt,
    })),
  });
}
```

Guard the route with your own auth/permissions (e.g. the `smrt-users`
`PermissionResolver`) — it exposes operational internals.

## 2. Client: poll it and map into the shell contracts

`systemFeed({ fetch, intervalMs, map })` calls your `fetch` on an interval and
maps the response into `ShellSystemPanel[]` (for `SystemScopePanel`) and
`ShellStatusChip[]` (for `SystemStatusChips`). It returns a controller whose
`panels` / `chips` are `$state`-reactive; bind them straight to the components
and call `dispose()` on teardown.

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { systemFeed } from '@happyvertical/smrt-svelte/workspace/live';
  import {
    SystemScopePanel,
    SystemStatusChips,
    type ShellStatusChip,
    type ShellSystemPanel,
  } from '@happyvertical/smrt-svelte/workspace';

  interface SystemStatus {
    counts: { queued: number; running: number; failed: number };
    workers: number;
    jobs: Array<{
      id: string;
      label: string;
      queue: string;
      status: string;
      detail?: string;
      updatedAt?: string;
    }>;
  }

  const feed = systemFeed<SystemStatus>({
    // App-owned transport — the helper only calls it.
    fetch: (signal) =>
      fetch('/admin/system/status', { signal }).then((r) => r.json()),
    intervalMs: 5000,
    map: (status) => ({
      chips: [
        { id: 'workers', label: 'Workers', value: status.workers, tone: 'info' },
        {
          id: 'running',
          label: 'Running',
          value: status.counts.running,
          tone: 'success',
        },
        {
          id: 'failed',
          label: 'Failed',
          value: status.counts.failed,
          tone: status.counts.failed > 0 ? 'error' : 'neutral',
        },
      ] satisfies ShellStatusChip[],
      panels: [
        {
          id: 'jobs',
          label: 'Jobs',
          items: status.jobs.map((job) => ({
            id: job.id,
            label: job.label,
            status: job.status,
            detail: job.detail,
            updatedAt: job.updatedAt,
          })),
        },
      ] satisfies ShellSystemPanel[],
    }),
  });

  onDestroy(feed.dispose);
</script>

<SystemStatusChips chips={feed.chips} />
<SystemScopePanel panels={feed.panels} />
```

Wire those two snippets into the shell's `systemBar` / `systemPanel` slots as
usual (see `SystemScopePanel` / `SystemStatusChips`).

## Behavior notes

- **Immediate first load** — fetches once on creation (disable with
  `immediate: false`), then every `intervalMs`. `intervalMs <= 0` disables the
  timer (single fetch; drive further loads with `refresh()`).
- **Errors are tolerated** — a rejected `fetch` or a throwing `map` sets
  `status: 'error'` and `error`, calls `onError`, and keeps polling. The last
  good `panels` / `chips` stay on screen.
- **Backgrounded tabs** — with the default `pauseWhenHidden: true`, ticks are
  skipped while `document.hidden` and one refresh fires when the tab becomes
  visible again. In SSR / non-DOM environments this is a no-op.
- **No overlap / no late writes** — each tick supersedes any in-flight fetch
  (via `AbortSignal`), and a stale response can never clobber a newer one.
- **Teardown** — `dispose()` stops the timer, detaches the visibility listener,
  and aborts any in-flight fetch. Always call it from `onDestroy`.
