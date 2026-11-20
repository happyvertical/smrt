import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOwnerHandoff, keepOwnerHandoffFresh } from './owner-handoff.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(location = '/setup?token=abc%2B123', profile = 'local') {
  // A fresh data folder: the state root does not exist yet.
  const base = mkdtempSync(join(tmpdir(), 'owner-handoff-'));
  dirs.push(base);
  const root = join(base, 'state');
  const ownerSetupLocation = vi.fn(async () => location);
  return {
    root,
    ownerSetupLocation,
    runtime: {
      resolvedRuntime: async () => ({ profile }),
      applicationStateRoot: () => root,
      ownerSetupLocation,
    },
  };
}

describe('ensureOwnerHandoff (#5165)', () => {
  it('writes the private one-time hand-off on a fresh data folder', async () => {
    const f = fresh();
    expect(await ensureOwnerHandoff(f.runtime, { PORT: '4796' })).toBe(true);
    const url = 'http://127.0.0.1:4796/setup?token=abc%2B123';
    expect(
      JSON.parse(readFileSync(join(f.root, 'onboarding.json'), 'utf8')),
    ).toEqual({ schemaVersion: 1, url });
    expect(
      readFileSync(join(f.root, 'onboarding-launch.html'), 'utf8'),
    ).toContain(`url=${url}`);
    for (const file of ['onboarding.json', 'onboarding-launch.html']) {
      expect(statSync(join(f.root, file)).mode & 0o077).toBe(0);
    }
  });

  it('defaults the port and never logs the token', async () => {
    const f = fresh();
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(process.stderr, 'write'),
      vi.spyOn(process.stdout, 'write'),
    ];
    await ensureOwnerHandoff(f.runtime, {});
    expect(readFileSync(join(f.root, 'onboarding.json'), 'utf8')).toContain(
      ':5173/setup?token=',
    );
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('abc');
      spy.mockRestore();
    }
  });

  it('keeps a hand-off that setup already saved (no rotation)', async () => {
    const f = fresh();
    await ensureOwnerHandoff(f.runtime, {});
    f.ownerSetupLocation.mockClear();
    expect(await ensureOwnerHandoff(f.runtime, {})).toBe(false);
    expect(f.ownerSetupLocation).not.toHaveBeenCalled();
  });

  it('replaces a saved hand-off whose token has expired, but never rewrites the same link (its age is the token age)', async () => {
    const f = fresh('/setup?token=old');
    await ensureOwnerHandoff(f.runtime, {});
    const file = join(f.root, 'onboarding.json');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(file, old, old);
    // the runtime still returns the same token: nothing is rewritten, the age stays
    expect(await ensureOwnerHandoff(f.runtime, {})).toBe(false);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
    // the runtime minted a new token after the old one expired
    f.ownerSetupLocation.mockResolvedValue('/setup?token=new');
    expect(await ensureOwnerHandoff(f.runtime, {})).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('token=new');
    expect(
      readFileSync(join(f.root, 'onboarding-launch.html'), 'utf8'),
    ).toContain('token=new');
    // a young link is kept without asking the runtime
    f.ownerSetupLocation.mockClear();
    expect(await ensureOwnerHandoff(f.runtime, {})).toBe(false);
    expect(f.ownerSetupLocation).not.toHaveBeenCalled();
  });

  it('renews an unclaimed link while the server runs, and stops once the claim removed it', async () => {
    vi.useFakeTimers();
    try {
      const f = fresh('/setup?token=one');
      await ensureOwnerHandoff(f.runtime, {});
      const file = join(f.root, 'onboarding.json');
      const stop = keepOwnerHandoffFresh(f.runtime, {}, 1000);
      f.ownerSetupLocation.mockResolvedValue('/setup?token=two');
      // age the file past the near-expiry mark, then let a tick run
      const old = new Date(Date.now() - 11 * 60_000);
      utimesSync(file, old, old);
      await vi.advanceTimersByTimeAsync(1000);
      expect(readFileSync(file, 'utf8')).toContain('token=two');
      // the claim removes the files: the loop stops and writes nothing back
      rmSync(file);
      f.ownerSetupLocation.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.ownerSetupLocation).not.toHaveBeenCalled();
      expect(existsSync(file)).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes nothing once an owner exists', async () => {
    const f = fresh('/');
    expect(await ensureOwnerHandoff(f.runtime, {})).toBe(false);
    expect(existsSync(join(f.root, 'onboarding.json'))).toBe(false);
  });

  it('writes nothing under the desktop wrapper or a non-local profile', async () => {
    const desktop = fresh();
    expect(
      await ensureOwnerHandoff(desktop.runtime, {
        SMRT_DESKTOP_OWNER_LINK_SECRET: 'a'.repeat(64),
      }),
    ).toBe(false);
    expect(desktop.ownerSetupLocation).not.toHaveBeenCalled();
    const cloud = fresh('/setup?token=x', 'cloud');
    expect(await ensureOwnerHandoff(cloud.runtime, {})).toBe(false);
    expect(cloud.ownerSetupLocation).not.toHaveBeenCalled();
  });

  it('never blocks startup when issuing fails', async () => {
    const f = fresh();
    f.ownerSetupLocation.mockRejectedValue(new Error('boom'));
    expect(await ensureOwnerHandoff(f.runtime, {})).toBe(false);
  });
});
