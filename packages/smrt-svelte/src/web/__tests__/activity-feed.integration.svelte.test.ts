/**
 * Integration test for the AdminShell activity feed adapter (#1779) end to end.
 *
 * Unlike the reconciler unit tests (which feed plain arrays), this exercises the
 * FULL stack — `activityFeed` → `liveCollection` → the real `@happyvertical/smrt-web`
 * collection with its client-data engine — through a mounted harness, so the
 * `$effect` that drives reconciliation has a genuine component-init scope. Only
 * the network boundary is mocked (the generated REST fetchers passed to
 * `createSmrtCollection`); the engine, live view, runes reactivity, and the real
 * `ShellState` are all live. This proves the reactive wiring drives the shell:
 * a loaded row and an optimistic insert both surface as shell activities.
 */

import {
  createSmrtCollection,
  type SmrtCrudFetchers,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
} from '@happyvertical/smrt-web';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellState } from '../../components/workspace/admin-shell/state.svelte.js';
import type { ShellState } from '../../components/workspace/index.js';
import type {
  ActivityFeedHandle,
  ActivityFeedMap,
} from '../activity-feed.svelte.js';
import Harness from './activity-feed-harness.svelte';

interface JobData {
  id?: string;
  title: string;
  state?: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
}

function jobDefinition(name: string): SmrtWebCollectionDefinition<JobData> {
  return {
    name,
    className: 'RenderJob',
    endpoint: `/${name}`,
    idField: 'id',
    actions: ['create', 'get', 'list'],
    fields: {
      title: { type: 'text', required: true },
      state: { type: 'text' },
    },
  };
}

/** Scripted stand-in for the generated REST fetchers (see live-collection test). */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const fetchers: SmrtCrudFetchers = {
    list: async () => serverRows.map((row) => ({ ...row })),
    create: async (data) => {
      const created = { ...data, id: `server-${serverRows.length + 1}` };
      serverRows.push(created);
      return { ...created };
    },
  };
  return { fetchers };
}

const mapJob: ActivityFeedMap<JobData> = (row) => ({
  kind: 'render-job',
  scope: 'focus',
  label: row.title,
  status: row.state ?? 'running',
});

function mountFeed(
  collection: SmrtWebCollection<JobData>,
  shell: ShellState,
): { handle: ActivityFeedHandle; teardown: () => void } {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let exposed = undefined as unknown as ActivityFeedHandle;
  const component = mount(Harness, {
    target,
    props: {
      // The harness is typed against the base object shape; JobData is a
      // structural subtype, so this cross-cast is purely nominal.
      collection: collection as unknown as SmrtWebCollection<
        Record<string, unknown>
      >,
      shell,
      map: mapJob as unknown as ActivityFeedMap<Record<string, unknown>>,
      onReady: (handle: ActivityFeedHandle) => {
        exposed = handle;
      },
    },
  });
  return {
    handle: exposed,
    teardown: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe('activityFeed (integration)', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it('reconciles loaded collection rows into shell activities', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'job-1', title: 'Render intro', state: 'running' },
      { id: 'job-2', title: 'Render outro', state: 'queued' },
    ]);
    const collection = createSmrtCollection(jobDefinition('feed-load'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });
    const shell = createShellState();

    const mounted = mountFeed(collection, shell);
    cleanup.push(mounted.teardown);
    await collection.preload();
    flushSync();

    const activities = shell.listActivities();
    expect(activities.map((a) => a.id).sort()).toEqual(['job-1', 'job-2']);
    expect(activities.every((a) => a.kind === 'render-job')).toBe(true);
    // Homed to the focus edge (right) per the map's scope.
    expect(shell.listActivities({ edge: 'right' })).toHaveLength(2);
  });

  it('surfaces an optimistic insert as a shell activity reactively', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'job-1', title: 'Render intro', state: 'running' },
    ]);
    const collection = createSmrtCollection(jobDefinition('feed-insert'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });
    const shell = createShellState();

    const mounted = mountFeed(collection, shell);
    cleanup.push(mounted.teardown);
    await collection.preload();
    flushSync();
    expect(shell.listActivities()).toHaveLength(1);

    // An optimistic insert appears in the live view synchronously → the feed
    // reconciles it into the shell on the reactive tick.
    const tx = collection.insert({
      id: 'local-1',
      title: 'Render credits',
      state: 'running',
    });
    flushSync();

    expect(
      shell
        .listActivities()
        .map((a) => a.label)
        .sort(),
    ).toEqual(['Render credits', 'Render intro']);

    // Once persisted, the server-assigned row replaces the optimistic one; the
    // activity for the temp id is removed and the server row's activity remains.
    await tx.isPersisted.promise;
    flushSync();

    const labels = shell
      .listActivities()
      .map((a) => a.label)
      .sort();
    expect(labels).toEqual(['Render credits', 'Render intro']);
    // The optimistic-id activity is gone; the server id is present.
    const ids = shell.listActivities().map((a) => a.id);
    expect(ids).toContain('server-2');
    expect(ids).not.toContain('local-1');
  });

  it('dispose() retracts the feed activities from the shell', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'job-1', title: 'Render intro', state: 'running' },
    ]);
    const collection = createSmrtCollection(jobDefinition('feed-dispose'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });
    const shell = createShellState();

    const mounted = mountFeed(collection, shell);
    cleanup.push(mounted.teardown);
    await collection.preload();
    flushSync();
    expect(shell.listActivities()).toHaveLength(1);

    mounted.handle.dispose();
    expect(shell.listActivities()).toHaveLength(0);
    expect(mounted.handle.isDisposed).toBe(true);
  });
});
