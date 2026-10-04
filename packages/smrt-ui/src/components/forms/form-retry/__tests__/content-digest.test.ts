/**
 * The browser port of `runOnce()`'s content digest (#3291) must agree with
 * core's `digestRunOnceContent()` byte for byte. These vectors were computed
 * with `@happyvertical/smrt-core`'s implementation; the same table lives in
 * `packages/core/src/__tests__/issue-3291-digest-vectors.test.ts`, so a change
 * to either side fails the other.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestSubmissionContent } from '../content-digest.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function orders(): { fd1: FormData; fd2: FormData } {
  const fd1 = new FormData();
  fd1.append('supplier', 'acme');
  fd1.append('qty', '2');
  fd1.append('qty', '3');
  fd1.append('note', 'héllo ✓');
  const fd2 = new FormData();
  fd2.append('supplier', 'acme');
  fd2.append('qty', '3');
  fd2.append('qty', '2');
  fd2.append('note', 'héllo ✓');
  return { fd1, fd2 };
}

describe('digestSubmissionContent', () => {
  it('matches core for plain JSON, toJSON values and the NUL-key escape', async () => {
    expect(
      await digestSubmissionContent({
        b: 1,
        a: [true, null, 'x'],
        c: { z: 1.5, y: 'é' },
      }),
    ).toBe('d9ae830ae60cc25876ef0bf6a94b95396a9feb02d8104d0ccca51dbed2b3483d');
    expect(
      await digestSubmissionContent({
        when: new Date('2026-10-01T12:00:00.000Z'),
        skip: undefined,
        arr: [undefined, 1],
      }),
    ).toBe('d5333d325d8f37a2421db409a9532616e23153c6c4312a51e42b645c045b7a00');
    expect(
      await digestSubmissionContent({ '\u0000FormData': [['a', 'b']] }),
    ).toBe('0d345acb479395e8c56d2a4abf52124dd22714777e38accfbe92df2c82bf7174');
    expect(await digestSubmissionContent(undefined)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
  });

  it('matches core for FormData: ordered, repeated fields significant', async () => {
    const { fd1, fd2 } = orders();
    expect(await digestSubmissionContent(fd1)).toBe(
      '67fc035f5a3f342757e9579c1520b2dd34ae91b921f5e5eab05e56b02553a1d5',
    );
    expect(await digestSubmissionContent(fd2)).toBe(
      'bc3d36f0e0441e887ffa641432f87a60cc3de592cff32a29cf35f5cb6fc0cd7d',
    );
    expect(await digestSubmissionContent(new FormData())).toBe(
      'c926873e5af4105c2192c4a1a4e4cd87665c0869cf24c025160416e1c167faec',
    );
    expect(await digestSubmissionContent({ form: fd1, extra: 'x' })).toBe(
      '2e89c1d455e7007af1f0826465c7e417a5c07900fc862293be42e7ae5928d00c',
    );
  });

  it('digests a File by name, type and size — never its bytes', async () => {
    const withFile = (bytes: string) => {
      const data = new FormData();
      data.append('title', 'Report');
      data.append('photo', new File([bytes], 'a.jpg', { type: 'image/jpeg' }));
      data.append(
        'empty',
        new File([], '', { type: 'application/octet-stream' }),
      );
      return data;
    };
    expect(await digestSubmissionContent(withFile('abc'))).toBe(
      'f16bbad3bdfd6fe4dc441855ecb2260e3fc14ed05d228deb50b5c0860c8f7208',
    );
    // Same name, type and size, different bytes: the same digest. Re-choosing
    // the same file after a reload is therefore the same claim.
    expect(await digestSubmissionContent(withFile('xyz'))).toBe(
      await digestSubmissionContent(withFile('abc')),
    );
  });

  it('rejects values JSON would misrepresent instead of hashing them as {}', async () => {
    await expect(digestSubmissionContent(new Map([['a', 1]]))).rejects.toThrow(
      TypeError,
    );
    await expect(digestSubmissionContent({ s: new Set([1]) })).rejects.toThrow(
      /Set/,
    );
    await expect(digestSubmissionContent({ n: 1n })).rejects.toThrow(/bigint/);
  });

  it('explains a missing Web Crypto (insecure context)', async () => {
    vi.stubGlobal('crypto', {});
    await expect(digestSubmissionContent({ a: 1 })).rejects.toThrow(
      /secure context/,
    );
  });
});
