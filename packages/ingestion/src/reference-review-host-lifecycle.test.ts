import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ getTestDatabase: vi.fn() }));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  getTestDatabase: database.getTestDatabase,
}));

import { ReferenceReviewHost } from '../reference/review-host.js';

describe('reference review host provisioning', () => {
  afterEach(() => database.getTestDatabase.mockReset());

  it('closes the database if fixture schema provisioning fails', async () => {
    const close = vi.fn();
    database.getTestDatabase.mockResolvedValue({
      query: vi.fn().mockRejectedValue(new Error('schema failed')),
      close,
    } as unknown as DatabaseInterface);

    await expect(
      ReferenceReviewHost.provision('/temporary/review'),
    ).rejects.toThrow('schema failed');

    expect(close).toHaveBeenCalledOnce();
  });
});
