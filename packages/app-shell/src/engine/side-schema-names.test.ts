// The side-schema validator accepts every name the generator produces, and
// ownership is exact (full-name hash), never a prefix match (#5187). Pure: no
// database.
import { describe, expect, it } from 'vitest';
import {
  assertAppSchema,
  assertSchemaName,
  isSideSchema,
  sideName,
} from './db/schema-name.ts';

const base = (len: number, tail = 'z') =>
  `app_${'x'.repeat(len - 4 - tail.length)}${tail}`;
const TAGS = ['d', 'r', 'o', 'n'] as const;

describe('side-schema names', () => {
  it.each([
    51, 52, 53, 62, 63,
  ])('every tag of a %i-character app schema is a name the engine accepts, owned by that app only', (len) => {
    const app = base(len);
    expect(app).toHaveLength(len);
    assertAppSchema(app);
    for (const tag of TAGS) {
      const name = sideName(app, tag, 'abcdef01');
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      expect(() => assertSchemaName(name)).not.toThrow();
      expect(isSideSchema(name)).toBe(true);
      expect(isSideSchema(name, app, tag)).toBe(true);
      // Never another tag's, and never a different app's, even one that
      // shares the whole kept prefix.
      for (const other of TAGS.filter((t) => t !== tag))
        expect(isSideSchema(name, app, other)).toBe(false);
      expect(isSideSchema(name, `${app.slice(0, -1)}q`)).toBe(false);
      expect(() => assertAppSchema(name)).toThrow(/looks like/);
    }
  });

  it('two apps sharing a long prefix never share a name or each other', () => {
    const a = `${'p'.repeat(52)}aaa`;
    const b = `${'p'.repeat(52)}bbb`;
    const na = sideName(a, 'r', 'cafe0000');
    expect(na).not.toBe(sideName(b, 'r', 'cafe0000'));
    expect(isSideSchema(na, a)).toBe(true);
    expect(isSideSchema(na, b)).toBe(false);
  });
});
