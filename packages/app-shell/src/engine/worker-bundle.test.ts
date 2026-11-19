import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppHost, bundledWorkerUrl, MemoryVersionStore } from './index.ts';

// The bundle exists after the package build (`tools/bundle-worker.mjs`). The
// whole engine suite also runs against it: `pnpm test:bundled-worker`.
const bundle = bundledWorkerUrl();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!bundle)('bundled worker (#5213)', () => {
  it('serves an app, keeping model names (no identifier mangling)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-bundle-'));
    dirs.push(dir);
    const host = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      workerUrl: bundle as URL,
    });
    try {
      for (const name of ['Chore', 'Chorus'])
        await host.execute(
          { type: 'defineModel', name, fields: { title: { type: 'text' } } },
          { author: 't' },
        );
      await host.create('Chore', { title: 'a' });
      await host.create('Chorus', { title: 'b' });
      expect(await host.list('Chore')).toHaveLength(1);
      expect(Object.keys(host.describe().models).sort()).toEqual([
        'Chore',
        'Chorus',
      ]);
    } finally {
      await host.close();
    }
  });
});
