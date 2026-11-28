// Reference resolution outside an operation is the engine's own unrestricted
// work (boot, data migrations); inside any operation with a principal it is
// restricted to what that caller may read (#5197).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_APP } from './definition.ts';
import { enginePrincipal, runAsPrincipal } from './principal.ts';

describe('reference resolution and the caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-limited-'));
  let rt: import('./app-runtime.ts').AppRuntime;
  let targetId = '';
  const def = {
    ...EMPTY_APP,
    name: 'refs',
    models: {
      Target: { label: 'Targets', fields: { name: { type: 'text' as const } } },
      Link: {
        label: 'Links',
        fields: {
          name: { type: 'text' as const },
          target: { type: 'reference' as const, ref: 'Target' },
        },
      },
    },
  };
  const who = (permissions: string[]) =>
    enginePrincipal({
      kind: 'user',
      tenantId: 'tenant',
      userId: 'staff',
      permissions,
    });

  beforeAll(async () => {
    const { AppRuntime } = await import('./app-runtime.ts');
    rt = new AppRuntime(dir, def as never, 1);
    await rt.boot();
    targetId = (await rt.create('Target', { name: 't' })).id as string;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('outside an operation (boot, migration) a reference resolves unrestricted', async () => {
    const r = await rt.create('Link', { name: 'a', target: targetId });
    expect(r.target).toBe(targetId);
  });

  it('inside an operation a caller who may not read the target is refused', async () => {
    await expect(
      runAsPrincipal(who([]), () =>
        rt.create('Link', { name: 'b', target: targetId }),
      ),
    ).rejects.toThrow(/no Target with id/);
  });
});
