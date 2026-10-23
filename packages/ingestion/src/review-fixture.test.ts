import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdtemp: filesystem.mkdtemp,
  rm: filesystem.rm,
}));

import { createReviewFixture } from '../e2e/review/fixture.js';
import type { ReferenceReviewHost } from '../reference/review-host.js';

function host(
  close: () => Promise<void>,
  settle: () => Promise<void> = async () => {},
): ReferenceReviewHost {
  return { db: { close }, settle } as unknown as ReferenceReviewHost;
}

describe('authenticated review fixture ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    filesystem.mkdtemp.mockReset();
    filesystem.rm.mockReset();
  });

  it('settles background stages, then closes its database before removing its owned root', async () => {
    const events: string[] = [];
    filesystem.mkdtemp.mockResolvedValue('/temporary/review-success');
    filesystem.rm.mockImplementation(async () => {
      events.push('remove');
    });
    const fixture = await createReviewFixture(async () =>
      host(
        async () => void events.push('close'),
        async () => void events.push('settle'),
      ),
    );

    await fixture.close();

    expect(events).toEqual(['settle', 'close', 'remove']);
  });

  it('removes its owned root when provisioning fails', async () => {
    const events: string[] = [];
    filesystem.mkdtemp.mockResolvedValue('/temporary/review-failure');
    const provision = async () => {
      events.push('provision');
      throw new Error('provision failed');
    };
    filesystem.rm.mockImplementation(async () => {
      events.push('remove');
    });

    await expect(createReviewFixture(provision)).rejects.toThrow(
      'provision failed',
    );

    expect(events).toEqual(['provision', 'remove']);
  });

  it('runs disposal once when shutdown is requested repeatedly', async () => {
    const events: string[] = [];
    filesystem.mkdtemp.mockResolvedValue('/temporary/review-repeat');
    filesystem.rm.mockImplementation(async () => {
      events.push('remove');
    });
    const fixture = await createReviewFixture(async () =>
      host(async () => void events.push('close')),
    );

    await Promise.all([fixture.close(), fixture.close()]);

    expect(events).toEqual(['close', 'remove']);
  });

  it('removes its owned root when database shutdown fails', async () => {
    const events: string[] = [];
    filesystem.mkdtemp.mockResolvedValue('/temporary/review-close-failure');
    const fixture = await createReviewFixture(async () =>
      host(async () => {
        events.push('close');
        throw new Error('close failed');
      }),
    );
    filesystem.rm.mockImplementation(async () => {
      events.push('remove');
    });
    await expect(fixture.close()).rejects.toThrow('close failed');

    expect(events).toEqual(['close', 'remove']);
  });
});
