import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ShellStatusChip,
  ShellSystemPanel,
} from '../admin-shell/types.js';
import { systemFeed } from '../live/system-feed.svelte.js';

/**
 * Lifecycle tests for the `systemFeed` polling helper (#1774). Real Svelte
 * `$state` reactivity + vitest fake timers; only the external `fetch` is
 * mocked. Each `dispose()`s its feed in `afterEach` to avoid leaked intervals.
 */

const disposers: Array<() => void> = [];

function track<T extends { dispose(): void }>(controller: T): T {
  disposers.push(() => controller.dispose());
  return controller;
}

/** Flush the interval + the async tick's microtasks. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function panel(id: string, itemCount: number): ShellSystemPanel {
  return {
    id,
    label: id,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `${id}-${index}`,
      label: `${id} ${index}`,
      status: 'running',
    })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  vi.useRealTimers();
  // Restore any spies (e.g. document.hidden / addEventListener) so they cannot
  // leak into later tests or files.
  vi.restoreAllMocks();
});

describe('systemFeed', () => {
  it('fetches immediately and maps the response into panels and chips', async () => {
    const fetch = vi.fn().mockResolvedValue({ jobs: 2 });
    const feed = track(
      systemFeed<{ jobs: number }>({
        fetch,
        intervalMs: 1000,
        pauseWhenHidden: false,
        map: (data) => ({
          panels: [panel('jobs', data.jobs)],
          chips: [{ id: 'jobs', label: 'Jobs', value: data.jobs }],
        }),
      }),
    );

    // Immediate tick is queued synchronously; flush its microtasks.
    await advance(0);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(feed.status).toBe('success');
    expect(feed.panels).toHaveLength(1);
    expect(feed.panels[0]?.items).toHaveLength(2);
    expect(feed.chips[0]?.value).toBe(2);
    expect(feed.running).toBe(true);
  });

  it('polls again on each interval tick', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    track(
      systemFeed({
        fetch,
        intervalMs: 1000,
        pauseWhenHidden: false,
        map: () => ({}),
      }),
    );

    await advance(0); // immediate
    expect(fetch).toHaveBeenCalledTimes(1);

    await advance(1000);
    expect(fetch).toHaveBeenCalledTimes(2);

    await advance(3000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('stops polling after the disposer runs', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = systemFeed({
      fetch,
      intervalMs: 1000,
      pauseWhenHidden: false,
      map: () => ({}),
    });

    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    feed.dispose();
    expect(feed.running).toBe(false);
    expect(feed.status).toBe('stopped');

    await advance(5000);
    // No further ticks after disposal.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stop() halts the timer while start() re-arms it', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 1000,
        pauseWhenHidden: false,
        map: () => ({}),
      }),
    );

    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    feed.stop();
    expect(feed.running).toBe(false);
    await advance(3000);
    expect(fetch).toHaveBeenCalledTimes(1);

    feed.start();
    expect(feed.running).toBe(true);
    await advance(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('tolerates a rejected fetch without stopping the loop and keeps prior data', async () => {
    const onError = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ n: 1 })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ n: 3 });
    const feed = track(
      systemFeed<{ n: number }>({
        fetch,
        intervalMs: 1000,
        pauseWhenHidden: false,
        onError,
        map: (data) => ({
          chips: [{ id: 'n', label: 'N', value: data.n } as ShellStatusChip],
        }),
      }),
    );

    await advance(0);
    expect(feed.chips[0]?.value).toBe(1);
    expect(feed.status).toBe('success');

    // Second tick rejects.
    await advance(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(feed.status).toBe('error');
    expect(feed.error).toBeInstanceOf(Error);
    // Last good data stays on screen.
    expect(feed.chips[0]?.value).toBe(1);

    // Third tick recovers.
    await advance(1000);
    expect(feed.status).toBe('success');
    expect(feed.error).toBeNull();
    expect(feed.chips[0]?.value).toBe(3);
  });

  it('tolerates a throwing mapper as a failed tick', async () => {
    const fetch = vi.fn().mockResolvedValue({ bad: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 1000,
        pauseWhenHidden: false,
        map: () => {
          throw new Error('map failed');
        },
      }),
    );

    await advance(0);
    expect(feed.status).toBe('error');
    expect(feed.error).toBeInstanceOf(Error);
    // Loop survives.
    await advance(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not fetch on creation when immediate is false', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 1000,
        immediate: false,
        pauseWhenHidden: false,
        map: () => ({}),
      }),
    );

    await advance(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(feed.status).toBe('idle');

    // First real load is the timer tick.
    await advance(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('runs a single fetch with no timer when intervalMs <= 0', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 0,
        pauseWhenHidden: false,
        map: () => ({}),
      }),
    );

    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    // No timer is armed, so `running` stays false (it tracks an armed timer).
    expect(feed.running).toBe(false);
    await advance(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Manual refresh still works.
    await feed.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refresh() fetches once off-schedule', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 0,
        immediate: false,
        pauseWhenHidden: false,
        map: () => ({}),
      }),
    );

    await advance(0);
    expect(fetch).not.toHaveBeenCalled();

    await feed.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('skips ticks while the document is hidden and refreshes on becoming visible', async () => {
    let hidden = false;
    const listeners: Array<() => void> = [];
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const addSpy = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation(
        (type: string, cb: EventListenerOrEventListenerObject) => {
          if (type === 'visibilitychange') listeners.push(cb as () => void);
        },
      );
    const removeSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementation(() => {});

    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 1000,
        // pauseWhenHidden defaults to true.
        map: () => ({}),
      }),
    );

    // Immediate tick while visible.
    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Go hidden — timer ticks are skipped.
    hidden = true;
    await advance(3000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Back to visible — the visibilitychange listener refreshes once.
    hidden = false;
    for (const cb of listeners) cb();
    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    feed.dispose();
    expect(removeSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('supersedes an in-flight fetch so a stale response cannot clobber newer data', async () => {
    let resolveFirst: ((value: { n: number }) => void) | undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ n: number }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ n: 2 });

    const feed = track(
      systemFeed<{ n: number }>({
        fetch,
        intervalMs: 0,
        immediate: false,
        pauseWhenHidden: false,
        map: (data) => ({
          chips: [{ id: 'n', label: 'N', value: data.n } as ShellStatusChip],
        }),
      }),
    );

    // Start a slow first fetch (never resolved yet).
    const first = feed.refresh();
    // Start a second fetch that resolves immediately; it supersedes the first.
    await feed.refresh();
    expect(feed.chips[0]?.value).toBe(2);

    // Now let the stale first fetch resolve — it must be ignored.
    resolveFirst?.({ n: 1 });
    await first;
    expect(feed.chips[0]?.value).toBe(2);
  });

  it('contains a throwing onError callback (no unhandled rejection)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const onError = vi.fn(() => {
      throw new Error('consumer onError blew up');
    });
    const fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 0,
        immediate: false,
        pauseWhenHidden: false,
        onError,
        map: () => ({}),
      }),
    );

    // The failing fetch invokes the throwing onError; the tick must still
    // resolve rather than reject.
    await expect(feed.refresh()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(feed.status).toBe('error');

    // Give any stray rejection a chance to surface, then assert none did.
    await advance(0);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('does not refresh on becoming visible after stop()', async () => {
    let hidden = false;
    const listeners: Array<() => void> = [];
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(document, 'addEventListener').mockImplementation(
      (type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') listeners.push(cb as () => void);
      },
    );
    vi.spyOn(document, 'removeEventListener').mockImplementation(() => {});

    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const feed = track(
      systemFeed({
        fetch,
        intervalMs: 1000,
        map: () => ({}),
      }),
    );

    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Pause polling (but the visibility listener is still attached — only
    // dispose() detaches it).
    feed.stop();
    expect(feed.running).toBe(false);

    // A hidden -> visible transition must NOT resurrect polling while stopped.
    hidden = true;
    hidden = false;
    for (const cb of listeners) cb();
    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
