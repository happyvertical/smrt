import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  storage: vi.fn(),
  store: vi.fn(),
  pack: vi.fn(),
}));
vi.mock('../src/lib/cookbook/store.svelte.ts', () => ({
  cookbookStore: { reset: calls.store },
}));
vi.mock('../src/lib/data/packs.ts', () => ({ setSamplePack: calls.pack }));
vi.mock('../src/lib/library/state.svelte.ts', () => ({
  libraryState: { active: 'manual', appliedWork: 'fingerprint' },
}));
vi.mock('../src/lib/planner/workspace-storage.ts', () => ({
  resetWorkspaceStorage: calls.storage,
  rememberPlan: () => false,
  setRememberPlan: () => true,
  workspaceStorageManager: () => ({}),
}));

import { resetWorkspace } from '../src/lib/planner/workspace.svelte.ts';

beforeEach(() => {
  vi.clearAllMocks();
});
it('leaves native conversation, manual plan, data, and host draft intact if storage reset fails', () => {
  calls.storage.mockReturnValue(false);
  const native = { reset: vi.fn() };
  const data = { reset: vi.fn() };
  const controller = { resetWorkspace: vi.fn() };
  const onreset = vi.fn();
  expect(
    resetWorkspace({
      nativeAssistant: native as never,
      dataSource: data as never,
      controller: controller as never,
      onreset,
    }),
  ).toBe(false);
  expect(native.reset).not.toHaveBeenCalled();
  expect(data.reset).not.toHaveBeenCalled();
  expect(calls.store).not.toHaveBeenCalled();
  expect(controller.resetWorkspace).not.toHaveBeenCalled();
  expect(onreset).not.toHaveBeenCalled();
});
it('clears storage before native invalidation and sends the host reset notification', () => {
  calls.storage.mockReturnValue(true);
  const native = { reset: vi.fn() };
  const data = { reset: vi.fn() };
  const controller = { resetWorkspace: vi.fn() };
  const onreset = vi.fn();
  expect(
    resetWorkspace({
      nativeAssistant: native as never,
      dataSource: data as never,
      controller: controller as never,
      onreset,
    }),
  ).toBe(true);
  expect(calls.storage.mock.invocationCallOrder[0]).toBeLessThan(
    native.reset.mock.invocationCallOrder[0],
  );
  expect(native.reset.mock.invocationCallOrder[0]).toBeLessThan(
    calls.store.mock.invocationCallOrder[0],
  );
  expect(calls.store).toHaveBeenCalledWith({ preserveTheme: true });
  expect(onreset).toHaveBeenCalledOnce();
});

it('notifies host draft reset even if a downstream reset listener throws', () => {
  calls.storage.mockReturnValue(true);
  const onreset = vi.fn();
  expect(() =>
    resetWorkspace({
      controller: {} as never,
      dataSource: {
        reset() {
          throw new Error('listener failed');
        },
      } as never,
      onreset,
    }),
  ).toThrow('listener failed');
  expect(onreset).toHaveBeenCalledOnce();
});
