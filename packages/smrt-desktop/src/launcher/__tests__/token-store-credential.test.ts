import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { LauncherProviderError } from '../provider.js';
import {
  acquireTokenStoreCredential,
  type LauncherTokenStore,
} from '../token-store-credential.js';
import {
  disposeNode,
  fakeProvider,
  nextLine,
  prepareNode,
  type Stage,
  type Stub,
  stageInstall,
  start,
  startStub,
  TOKEN,
} from './harness.js';

function fakeStore(overrides: Partial<LauncherTokenStore> = {}) {
  const store = {
    issue: vi.fn(async () => ({ id: 'tok-1', token: TOKEN })),
    revoke: vi.fn(async () => 'revoked'),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  return store as typeof store & LauncherTokenStore;
}

describe('acquireTokenStoreCredential', () => {
  it('issues one token with the given scopes and an eight hour default lifetime', async () => {
    const store = fakeStore();
    const credential = await acquireTokenStoreCredential({
      openStore: async () => store,
      scopes: ['mcp:use'],
      label: 'Desktop launcher',
    });
    expect(credential.token).toBe(TOKEN);
    expect(store.issue).toHaveBeenCalledWith({
      scopes: ['mcp:use'],
      expiresInSeconds: 28_800,
      label: 'Desktop launcher',
    });
    expect(store.close).not.toHaveBeenCalled();
  });

  it('closes the store once on release, however often it is called, and never revokes', async () => {
    const store = fakeStore();
    const credential = await acquireTokenStoreCredential({
      openStore: async () => store,
      scopes: ['mcp:use'],
    });
    await credential.release?.();
    await credential.release?.();
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('does not fail a release when closing the store fails', async () => {
    const store = fakeStore({
      close: vi.fn(async () => {
        throw new Error('closed twice');
      }),
    });
    const credential = await acquireTokenStoreCredential({
      openStore: async () => store,
      scopes: ['mcp:use'],
    });
    await expect(credential.release?.()).resolves.toBeUndefined();
  });

  it('maps a store that cannot be opened to credential_unavailable without echoing the cause', async () => {
    const failure = acquireTokenStoreCredential({
      openStore: async () => {
        throw new Error('/secret/path/application.sqlite is locked');
      },
      scopes: ['mcp:use'],
    });
    await expect(failure).rejects.toSatisfy(
      (error) =>
        LauncherProviderError.is(error) &&
        error.code === 'credential_unavailable' &&
        !error.message.includes('/secret'),
    );
  });

  it('closes the store and reports credential_unavailable when issuing fails', async () => {
    const store = fakeStore({
      issue: vi.fn(async () => {
        throw new Error('scope not held by the owner');
      }),
    });
    await expect(
      acquireTokenStoreCredential({
        openStore: async () => store,
        scopes: ['nope'],
      }),
    ).rejects.toSatisfy(
      (error) =>
        LauncherProviderError.is(error) &&
        error.code === 'credential_unavailable',
    );
    expect(store.close).toHaveBeenCalledTimes(1);
  });
});

describe('through runLauncher', () => {
  let stub: Stub;
  let stage: Stage;
  beforeAll(prepareNode);
  afterAll(disposeNode);
  beforeEach(async () => {
    stub = await startStub();
    stage = await stageInstall();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('keeps the token valid while the bridge runs: the launcher releases it at start, and nothing revokes it', async () => {
    const store = fakeStore();
    const provider = fakeProvider(stage, stub, {
      credential: () =>
        acquireTokenStoreCredential({
          openStore: async () => store,
          scopes: ['mcp:use'],
        }),
    });
    const run = start(provider, stub);
    await nextLine(run, { cmd: 'info' });
    // The bridge is running and has forwarded a request with the token.
    const forwarded = await nextLine<{ status: number }>(run, {
      cmd: 'forward',
    });
    expect(forwarded.status).toBe(200);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(store.revoke).not.toHaveBeenCalled();

    run.stdin.end();
    expect(await run.result).toBe(0);
    expect(store.revoke).not.toHaveBeenCalled();
  });
});
