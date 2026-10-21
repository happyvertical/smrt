/**
 * `reflect-metadata` defines `Reflect.decorate`, which tsc-style `__decorate`
 * helpers delegate to, so once it is loaded (it is a dependency of
 * `@simplewebauthn/server`, tsyringe, ...) every decorator is applied from a
 * `reflect-metadata/Reflect.js` frame. Source/package attribution walked the
 * stack to the first frame outside smrt-core and stopped at that frame,
 * registering a phantom `@happyvertical/smrt:<Class>` whose source file was
 * Reflect.js, which collided with the real registration on the same table.
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { field, ObjectRegistry, SmrtObject, smrt } from '../../index';
import { isDecoratorRuntimeFramePath } from '../../utils/stack-frames.js';
import { getSourceFileFromStack } from '../shared-state.js';

@smrt({
  tableName: 'reflect_metadata_things',
  api: false,
  cli: false,
  mcp: false,
})
class ReflectMetadataThing extends SmrtObject {
  @field({ type: 'text' })
  label = '';
}

describe('decorators applied through reflect-metadata', () => {
  it('is actually loaded, so decorators run through Reflect.decorate', () => {
    expect(typeof (Reflect as { decorate?: unknown }).decorate).toBe(
      'function',
    );
  });

  it('treats a reflect-metadata frame as plumbing, not a declaring module', () => {
    expect(
      isDecoratorRuntimeFramePath(
        '/repo/node_modules/.pnpm/reflect-metadata@0.2.2/node_modules/reflect-metadata/Reflect.js',
      ),
    ).toBe(true);
    const stack = [
      'Error',
      '    at registerClass (/repo/node_modules/@happyvertical/smrt-core/src/registry.ts:1:1)',
      '    at Reflect.decorate (/repo/node_modules/reflect-metadata/Reflect.js:541:30)',
      '    at /repo/src/models/Widget.ts:5:1',
    ].join('\n');
    expect(getSourceFileFromStack(stack)).toBe('/repo/src/models/Widget.ts');
  });

  it('registers the class once, with its fields, attributed to its own file', () => {
    expect(ObjectRegistry.getFields('ReflectMetadataThing').has('label')).toBe(
      true,
    );
    const phantoms = [...ObjectRegistry.getAllClasses().entries()].filter(
      ([, registered]) =>
        registered.name === 'ReflectMetadataThing' ||
        registered.sourceFilePath?.includes('reflect-metadata/Reflect.js'),
    );
    expect(phantoms).toHaveLength(1);
    expect(phantoms[0]?.[1].sourceFilePath).toContain(
      'reflect-metadata-attribution.test.ts',
    );
    expect(ReflectMetadataThing).toBeDefined();
  });
});
