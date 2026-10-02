/**
 * Pinned `digestRunOnceContent()` vectors shared with the browser port (#3291).
 *
 * `@happyvertical/smrt-ui/form-retry` ships `digestSubmissionContent()`, a Web
 * Crypto port of this digest, so a browser can compute the same content
 * digest `runOnce()` will. The identical table lives in
 * `packages/smrt-ui/src/components/forms/form-retry/__tests__/content-digest.test.ts`:
 * changing the digest here without changing the port (or the reverse) fails
 * one side. Changing it at all also changes every stored claim key, so a
 * deliberate change needs a migration story, not just new vectors.
 */

import { describe, expect, it } from 'vitest';
import { digestRunOnceContent } from '../run-once';

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

describe('digestRunOnceContent shared vectors (#3291)', () => {
  it('plain JSON, toJSON values, the NUL-key escape and an omitted top level', () => {
    expect(
      digestRunOnceContent({
        b: 1,
        a: [true, null, 'x'],
        c: { z: 1.5, y: 'é' },
      }),
    ).toBe('d9ae830ae60cc25876ef0bf6a94b95396a9feb02d8104d0ccca51dbed2b3483d');
    expect(
      digestRunOnceContent({
        when: new Date('2026-10-01T12:00:00.000Z'),
        skip: undefined,
        arr: [undefined, 1],
      }),
    ).toBe('d5333d325d8f37a2421db409a9532616e23153c6c4312a51e42b645c045b7a00');
    expect(digestRunOnceContent({ '\u0000FormData': [['a', 'b']] })).toBe(
      '0d345acb479395e8c56d2a4abf52124dd22714777e38accfbe92df2c82bf7174',
    );
    expect(digestRunOnceContent(undefined)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
  });

  it('FormData, repeated fields, empty and nested forms', () => {
    const { fd1, fd2 } = orders();
    expect(digestRunOnceContent(fd1)).toBe(
      '67fc035f5a3f342757e9579c1520b2dd34ae91b921f5e5eab05e56b02553a1d5',
    );
    expect(digestRunOnceContent(fd2)).toBe(
      'bc3d36f0e0441e887ffa641432f87a60cc3de592cff32a29cf35f5cb6fc0cd7d',
    );
    expect(digestRunOnceContent(new FormData())).toBe(
      'c926873e5af4105c2192c4a1a4e4cd87665c0869cf24c025160416e1c167faec',
    );
    expect(digestRunOnceContent({ form: fd1, extra: 'x' })).toBe(
      '2e89c1d455e7007af1f0826465c7e417a5c07900fc862293be42e7ae5928d00c',
    );
  });

  it('a File entry, by name, type and size', () => {
    const data = new FormData();
    data.append('title', 'Report');
    data.append('photo', new File(['abc'], 'a.jpg', { type: 'image/jpeg' }));
    data.append(
      'empty',
      new File([], '', { type: 'application/octet-stream' }),
    );
    expect(digestRunOnceContent(data)).toBe(
      'f16bbad3bdfd6fe4dc441855ecb2260e3fc14ed05d228deb50b5c0860c8f7208',
    );
  });
});
