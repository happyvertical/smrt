import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  imports: vi.fn(),
  profile: vi.fn(),
  handoff: vi.fn(),
  fresh: vi.fn(),
  install: vi.fn(),
  createDrain: vi.fn(),
  closeStreams: vi.fn(),
  stopImports: vi.fn(),
  drain: vi.fn(),
  gate: vi.fn(),
  provisioning: vi.fn(),
  stopProvisioning: vi.fn(),
  methodCode: vi.fn(),
  env: { dev: false, building: false },
}));
vi.mock('$app/environment', () => mocks.env);
vi.mock('$lib/server/shutdown', () => ({ createDrain: mocks.createDrain }));
vi.mock('$lib/server/embed-slot', () => ({
  registerEmbeddedDrain: mocks.install,
}));
vi.mock('$lib/server/host', () => ({
  shellProfile: mocks.profile,
  drainShell: mocks.drain,
}));
vi.mock('$lib/server/hosted-inference', () => ({
  installHostedInferenceGate: mocks.gate,
}));
vi.mock('$lib/server/method-code', () => ({
  installMethodCodeGate: mocks.methodCode,
}));
vi.mock('$lib/server/hosted-provisioning', () => ({
  installHostedProvisioning: mocks.provisioning,
  stopHostedProvisioning: mocks.stopProvisioning,
}));
vi.mock('$lib/server/owner-handoff', () => ({
  ensureOwnerHandoff: mocks.handoff,
  keepOwnerHandoffFresh: mocks.fresh,
}));
vi.mock('$lib/server/smrt', () => ({
  runtime: { ready: mocks.ready, handle: vi.fn() },
}));
vi.mock('$lib/server/import-runtime', () => ({
  shellImports: mocks.imports,
  stopShellImports: mocks.stopImports,
}));
vi.mock('$lib/server/events', () => ({ closeAllStreams: mocks.closeStreams }));
vi.mock('$lib/server/apps-rest', () => ({ appsRestHandle: vi.fn() }));

import { init } from './hooks.server.ts';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.dev = false;
  mocks.env.building = false;
  mocks.profile.mockResolvedValue('local');
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
it('starts none of the desktop-only work on the cloud profile', async () => {
  const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  mocks.profile.mockResolvedValue('cloud');
  mocks.imports.mockRejectedValue(new Error('no job runner'));
  await expect(init()).resolves.toBeUndefined();
  expect(mocks.ready).toHaveBeenCalledOnce();
  expect(mocks.imports).not.toHaveBeenCalled();
  expect(mocks.handoff).not.toHaveBeenCalled();
  expect(mocks.fresh).not.toHaveBeenCalled();
  // No "imports are unavailable" warning on every hosted start.
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
it('still starts the owner link and imports on the local profile', async () => {
  mocks.imports.mockResolvedValue({});
  await init();
  expect(mocks.handoff).toHaveBeenCalledOnce();
  expect(mocks.fresh).toHaveBeenCalledOnce();
  expect(mocks.imports).toHaveBeenCalledOnce();
});
it('hands the ordered drain to the entries once the runtime is ready, not under vite dev or build', async () => {
  mocks.imports.mockResolvedValue({});
  const drainFn = vi.fn();
  mocks.createDrain.mockReturnValue(drainFn);
  await init();
  expect(mocks.createDrain).toHaveBeenCalledWith({
    drain: mocks.drain,
    endStreams: mocks.closeStreams,
    stopWork: expect.any(Function),
  });
  // Shutdown stops hosted provisioning's watcher and timer, then the imports.
  const { stopWork } = mocks.createDrain.mock.calls[0][0];
  await stopWork();
  expect(mocks.stopProvisioning).toHaveBeenCalledOnce();
  expect(mocks.stopImports).toHaveBeenCalledOnce();
  expect(mocks.install).toHaveBeenCalledWith(drainFn, {
    run: expect.any(Function),
  });
  mocks.install.mockClear();
  mocks.env.dev = true;
  await init();
  mocks.env.dev = false;
  mocks.env.building = true;
  await init();
  expect(mocks.install).not.toHaveBeenCalled();
});
it('registers the hosted inference gate at startup and does not start without it', async () => {
  mocks.profile.mockResolvedValue('cloud');
  await expect(init()).resolves.toBeUndefined();
  expect(mocks.gate).toHaveBeenCalledOnce();
  mocks.gate.mockRejectedValueOnce(new Error('no kill switch table'));
  await expect(init()).rejects.toThrow('no kill switch table');
  expect(mocks.handoff).not.toHaveBeenCalled();
});
it('registers hosted provisioning after the gate, and only once the gate is in', async () => {
  mocks.profile.mockResolvedValue('cloud');
  await expect(init()).resolves.toBeUndefined();
  expect(mocks.provisioning).toHaveBeenCalledOnce();
  expect(mocks.gate.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.provisioning.mock.invocationCallOrder[0],
  );
  mocks.provisioning.mockClear();
  mocks.gate.mockRejectedValueOnce(new Error('no kill switch table'));
  await expect(init()).rejects.toThrow('no kill switch table');
  expect(mocks.provisioning).not.toHaveBeenCalled();
});
it('installs the method-code entitlement check after the gate, and does not start without it', async () => {
  mocks.profile.mockResolvedValue('cloud');
  await expect(init()).resolves.toBeUndefined();
  expect(mocks.methodCode).toHaveBeenCalledOnce();
  expect(mocks.gate.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.methodCode.mock.invocationCallOrder[0],
  );
  mocks.methodCode.mockRejectedValueOnce(new Error('no feature tables'));
  await expect(init()).rejects.toThrow('no feature tables');
});
