import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ready: vi.fn(), imports: vi.fn() }));
vi.mock('$lib/server/smrt', () => ({
  runtime: { ready: mocks.ready, handle: vi.fn() },
}));
vi.mock('$lib/server/import-runtime', () => ({ shellImports: mocks.imports }));
vi.mock('$lib/server/apps-rest', () => ({ appsRestHandle: vi.fn() }));

import { init } from './hooks.server.ts';

beforeEach(() => {
  vi.resetAllMocks();
});
it('serves the shell when import initialization or recovery fails and can retry imports lazily', async () => {
  const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  mocks.imports.mockRejectedValueOnce(new Error('private import failure'));
  await expect(init()).resolves.toBeUndefined();
  expect(mocks.ready).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(
    'Workbook imports are unavailable. Opening Import will try again.\n',
  );
  expect(warn.mock.calls.flat().join(' ')).not.toContain('private');
  mocks.imports.mockResolvedValue({});
  await expect(init()).resolves.toBeUndefined();
  expect(mocks.imports).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});
it('still fails closed on the runtime startup guard', async () => {
  mocks.ready.mockRejectedValueOnce(new Error('migration guard'));
  await expect(init()).rejects.toThrow('migration guard');
  expect(mocks.imports).not.toHaveBeenCalled();
});
