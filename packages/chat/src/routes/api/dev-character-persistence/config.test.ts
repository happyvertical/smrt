import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasSameOrigin,
  isLocalDevCharacterRequest,
  resolveDevCharacterPersistenceConfig,
} from './config.js';

const names = [
  'SMRT_CHAT_DEV_CHARACTER_PERSISTENCE',
  'SMRT_CHAT_DEV_CHARACTER_DATABASE_URL',
  'SMRT_CHAT_DEV_CHARACTER_ASSET_DIR',
  'SMRT_CHAT_DEV_CHARACTER_PROFILE_ID',
  'SMRT_CHAT_DEV_CHARACTER_TENANT_ID',
] as const;
const original = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('dev character persistence boundary', () => {
  it('defaults disabled and only accepts temporary server configuration', () => {
    for (const name of names) delete process.env[name];
    expect(resolveDevCharacterPersistenceConfig()).toBeNull();
    process.env.SMRT_CHAT_DEV_CHARACTER_PERSISTENCE = 'true';
    process.env.SMRT_CHAT_DEV_CHARACTER_DATABASE_URL = join(
      tmpdir(),
      'character.db',
    );
    process.env.SMRT_CHAT_DEV_CHARACTER_ASSET_DIR = join(
      tmpdir(),
      'character-assets',
    );
    process.env.SMRT_CHAT_DEV_CHARACTER_PROFILE_ID = 'dev-profile';
    process.env.SMRT_CHAT_DEV_CHARACTER_TENANT_ID = 'dev-tenant';
    expect(resolveDevCharacterPersistenceConfig()).toMatchObject({
      databaseUrl: join(tmpdir(), 'character.db'),
      profileId: 'dev-profile',
      tenantId: 'dev-tenant',
    });
    process.env.SMRT_CHAT_DEV_CHARACTER_ASSET_DIR = '/var/character-assets';
    expect(resolveDevCharacterPersistenceConfig).toThrow('ASSET_DIR');
  });

  it('allows only a trusted loopback peer with a same-origin request', () => {
    const local = new Request(
      'http://127.0.0.1:4187/api/dev-character-persistence',
      {
        headers: { origin: 'http://127.0.0.1:4187' },
      },
    );
    expect(
      isLocalDevCharacterRequest({
        dev: true,
        request: local,
        getClientAddress: () => '127.0.0.1',
      }),
    ).toBe(true);
    expect(hasSameOrigin(local)).toBe(true);
    const remote = new Request(
      'https://example.test/api/dev-character-persistence',
      {
        headers: { origin: 'https://attacker.test' },
      },
    );
    expect(
      isLocalDevCharacterRequest({
        dev: true,
        request: local,
        getClientAddress: () => '203.0.113.1',
      }),
    ).toBe(false);
    expect(
      isLocalDevCharacterRequest({
        dev: true,
        request: local,
        getClientAddress: () => {
          throw new Error('unavailable');
        },
      }),
    ).toBe(false);
    expect(hasSameOrigin(remote)).toBe(false);
  });
});
