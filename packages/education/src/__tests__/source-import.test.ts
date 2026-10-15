import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CourseSource } from '../course-source.js';
import {
  assertAuthorizationAndSharing,
  assertInputAndIdentityGuards,
  assertRefreshAndPrivacy,
  assertRollbackAndRetry,
  sourceFixture,
} from './source-import-contract.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

describe('source import (SQLite)', () => {
  for (const [name, contract] of [
    [
      'retains identities and history; real catalog excludes other owners',
      assertRefreshAndPrivacy,
    ],
    ['enforces actor and source sharing matrix', assertAuthorizationAndSharing],
    [
      'rolls back later failures and retries serialized imports',
      assertRollbackAndRetry,
    ],
    [
      'validates fetch, rechecks policy and rejects corrupted identities',
      assertInputAndIdentityGuards,
    ],
  ] as const) {
    it(name, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: [
          'Tenant',
          'CourseSource',
          'Course',
          'CourseSection',
          'Lesson',
        ],
      });
      try {
        await contract(await sourceFixture(db));
      } finally {
        await db.close?.();
      }
    });
  }
  it('keeps source configuration guarded and generated surfaces closed', () => {
    const source = new CourseSource();
    expect(source.sharing).toBe('private');
    expect(() => source.setConfig([] as never)).toThrow();
    expect(source.getConfig()).toEqual({});
    expect(() => source.setConfig({ licenseEvidence: 123 } as never)).toThrow();
    expect(() => source.setConfig({ unknown: true } as never)).toThrow();
    const config = ObjectRegistry.getClass('CourseSource')?.config;
    expect(config).toMatchObject({ api: false, cli: false, mcp: false });
  });
});
