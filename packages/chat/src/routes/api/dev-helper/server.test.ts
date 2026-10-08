import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dev: true,
  config: vi.fn(() => ({
    databaseUrl: '/tmp/test.db',
    assetDirectory: '/tmp/assets',
    profileId: 'profile',
    tenantId: 'tenant',
  })),
  service: { load: vi.fn(), save: vi.fn(), reset: vi.fn() },
  close: vi.fn(),
  open: vi.fn(),
}));
vi.mock('$app/environment', () => ({
  get dev() {
    return mocks.dev;
  },
}));
vi.mock('../../../dev-helper-server.js', () => ({
  openDevHelperService: mocks.open,
  serializeDevHelperWrite: async (_config: unknown, operation: () => unknown) =>
    operation(),
}));
vi.mock('../dev-character-persistence/config.js', () => ({
  resolveDevCharacterPersistenceConfig: mocks.config,
  isLocalDevCharacterRequest: ({ dev, request, getClientAddress }: any) =>
    dev &&
    getClientAddress() === '127.0.0.1' &&
    (!request.headers.get('origin') ||
      request.headers.get('origin') === new URL(request.url).origin),
}));

import { DELETE, GET, POST } from './+server.js';

const url = new URL('http://127.0.0.1:4189/api/dev-helper');
const event = (request: Request, address = () => '127.0.0.1') =>
  ({ request, getClientAddress: address }) as Parameters<typeof GET>[0];
const snapshot = {
  preferences: null,
  offering: null,
  selection: 'personal',
  source: 'default',
  offerings: [],
  voices: [],
  permissions: { editableFields: [], canReset: false, customStyleIds: [] },
  hasOverride: false,
  recovery: null,
};

describe('dev helper loopback route', () => {
  beforeEach(() => {
    mocks.dev = true;
    mocks.config.mockClear();
    mocks.open.mockReset();
    mocks.close.mockReset();
    mocks.service.load.mockResolvedValue(snapshot);
    mocks.service.save.mockResolvedValue(snapshot);
    mocks.service.reset.mockResolvedValue(snapshot);
    mocks.open.mockResolvedValue({
      context: {
        actorProfileId: 'profile',
        profileId: 'profile',
        tenantId: 'tenant',
        applicationId: 'smrt-chat-dev-helper',
      },
      service: mocks.service,
      close: mocks.close,
    });
  });
  it('serves load, full save, and reset with a route-generated context', async () => {
    await expect(GET(event(new Request(url)))).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      POST(
        event(
          new Request(url, {
            method: 'POST',
            body: JSON.stringify({ version: 1 }),
          }),
        ),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      DELETE(event(new Request(url, { method: 'DELETE' }))),
    ).resolves.toMatchObject({ status: 200 });
    expect(mocks.service.save).toHaveBeenCalledWith(expect.anything(), {
      version: 1,
    });
  });
  it('rejects production, remote, hostile-origin, and oversized requests before opening storage', async () => {
    mocks.dev = false;
    await expect(GET(event(new Request(url)))).rejects.toMatchObject({
      status: 404,
    });
    mocks.dev = true;
    await expect(
      GET(event(new Request(url), () => '203.0.113.3')),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      GET(
        event(new Request(url, { headers: { origin: 'https://evil.test' } })),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      POST(
        event(
          new Request(url, {
            method: 'POST',
            headers: { 'content-length': '2049' },
            body: '{}',
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
});
