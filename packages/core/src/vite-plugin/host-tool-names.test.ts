import { describe, expect, it } from 'vitest';
import {
  assertNoHostToolNameCollisions,
  checkHostToolNameCollisions,
  type HostToolNameDeclaration,
  smrtPlugin,
} from './index.js';

const decl = (
  name: string,
  surface: HostToolNameDeclaration['surface'],
  declaredBy: string,
): HostToolNameDeclaration => ({ name, surface, declaredBy });

describe('host tool-name collisions', () => {
  it('passes a clean set, including one operation projected on every surface', () => {
    const clean = [
      decl('review_apply', 'workflow', 'ReviewApply'),
      decl('review_apply', 'bespoke', 'ReviewApply'),
      decl('review_apply', 'mcp', 'ReviewApply'),
      decl('course_list', 'workflow', 'CourseList'),
    ];
    expect(checkHostToolNameCollisions(clean)).toEqual([]);
    expect(() => assertNoHostToolNameCollisions(clean)).not.toThrow();
  });

  it.each([
    ['workflow', 'bespoke'],
    ['workflow', 'mcp'],
    ['bespoke', 'mcp'],
  ] as const)('fails a duplicate across %s and %s naming both sources', (a, b) => {
    const set = [
      decl('dup_tool', a, 'src/a.ts'),
      decl('dup_tool', b, 'src/b.ts'),
    ];
    expect(() => assertNoHostToolNameCollisions(set)).toThrow(
      /dup_tool.*src\/a\.ts \(.*\).*src\/b\.ts \(.*\)/s,
    );
    const [collision] = checkHostToolNameCollisions(set);
    expect(collision.first.surface).toBe(a);
    expect(collision.second.surface).toBe(b);
  });

  it('fails a host tool that shadows a generated model tool', () => {
    expect(() =>
      assertNoHostToolNameCollisions(
        [decl('product_list', 'bespoke', 'src/x.ts')],
        [{ name: 'product_list', declaredBy: 'Product.list' }],
      ),
    ).toThrow(/Product\.list.*src\/x\.ts/s);
  });

  it('fails the build at plugin construction on host duplicates only', () => {
    expect(() =>
      smrtPlugin({
        hostToolNames: [decl('a', 'workflow', 'X'), decl('a', 'bespoke', 'Y')],
      }),
    ).toThrow(/collision/);
    expect(() =>
      smrtPlugin({ hostToolNames: [decl('a', 'workflow', 'X')] }),
    ).not.toThrow();
  });
});
