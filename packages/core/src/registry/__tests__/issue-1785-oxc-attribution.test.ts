/**
 * Regression tests for issue #1785: ObjectRegistry misattributes
 * decorator-registered classes to `@oxc-project/runtime` under oxc-lowered
 * decorators.
 *
 * Under Vite 8, oxc's legacy-decorator lowering routes the `@smrt()` application
 * through `@oxc-project/runtime`'s helper module, so the registration call stack
 * carries an `@oxc-project/runtime` frame BETWEEN the smrt-core frames and the
 * consumer module that declares the class. The two stack walkers that derive a
 * class's identity — package attribution (`getPackageName`) and source-file
 * identity (`getSourceFileFromStack`) — must skip that helper frame and continue
 * to the real declaring module.
 *
 * These tests simulate the lowered call pattern with synthetic stacks (the
 * `stackOverride` test hook) so they assert the exact behavior without needing a
 * real oxc build. Paths under `/nonexistent-1785/...` never resolve on disk, so
 * `getPackageName`'s package.json walk (method 3) finds nothing and the
 * node_modules fallback (method 4) is exercised.
 */

import { describe, expect, it } from 'vitest';
import { getPackageName } from '../../manifest/manifest-loader.js';
import type { SmrtObjectConstructor } from '../../registry/types.js';
import {
  DECORATOR_RUNTIME_PACKAGES,
  isDecoratorRuntimeFramePath,
  isDecoratorRuntimePackageName,
} from '../../utils/stack-frames.js';
import { getSourceFileFromStack } from '../shared-state.js';

// A pnpm-resolved oxc runtime helper frame — the shape oxc's legacy-decorator
// lowering inserts when it applies a class decorator.
const OXC_FRAME =
  '    at applyDecoratedDescriptor (/nonexistent-1785/node_modules/.pnpm/@oxc-project+runtime@0.138.0/node_modules/@oxc-project/runtime/src/helpers/esm/applyDecoratedDescriptor.js:12:3)';
// A smrt-core internal frame (the registration entry point).
const CORE_FRAME =
  '    at register (/repo/packages/core/src/registry/class-registration.ts:581:10)';

describe('#1785: decorator-runtime frame detection', () => {
  it('recognizes @oxc-project/runtime as a decorator-runtime package', () => {
    expect(isDecoratorRuntimePackageName('@oxc-project/runtime')).toBe(true);
    expect(DECORATOR_RUNTIME_PACKAGES).toContain('@oxc-project/runtime');
  });

  it('recognizes the other common lowering helpers', () => {
    expect(isDecoratorRuntimePackageName('@swc/helpers')).toBe(true);
    expect(isDecoratorRuntimePackageName('@babel/runtime')).toBe(true);
    expect(isDecoratorRuntimePackageName('tslib')).toBe(true);
  });

  it('does not flag ordinary consumer packages', () => {
    expect(isDecoratorRuntimePackageName('@acme/widgets')).toBe(false);
    expect(isDecoratorRuntimePackageName('@happyvertical/smrt-content')).toBe(
      false,
    );
  });

  it('matches oxc runtime helper file paths (plain and pnpm forms)', () => {
    expect(
      isDecoratorRuntimeFramePath(
        '/app/node_modules/@oxc-project/runtime/src/helpers/esm/decorate.js',
      ),
    ).toBe(true);
    expect(
      isDecoratorRuntimeFramePath(
        '/app/node_modules/.pnpm/@oxc-project+runtime@0.138.0/node_modules/@oxc-project/runtime/src/helpers/esm/applyDecoratedDescriptor.js',
      ),
    ).toBe(true);
    expect(
      isDecoratorRuntimeFramePath('/app/node_modules/tslib/tslib.es6.js'),
    ).toBe(true);
  });

  it('does not match consumer module paths', () => {
    expect(isDecoratorRuntimeFramePath('/app/src/lib/objects/Widget.ts')).toBe(
      false,
    );
    // A directory that merely contains "tslib" as a substring must not match.
    expect(
      isDecoratorRuntimeFramePath('/app/node_modules/mytslibs/index.js'),
    ).toBe(false);
  });
});

describe('#1785: getPackageName skips the oxc helper frame', () => {
  const ctor = { name: 'Widget' } as unknown as SmrtObjectConstructor;

  it('attributes to the consumer package, not @oxc-project/runtime', () => {
    const stack = [
      'Error',
      CORE_FRAME,
      OXC_FRAME,
      '    at Widget (/nonexistent-1785/node_modules/.pnpm/@acme+widgets@1.0.0/node_modules/@acme/widgets/dist/objects/Widget.js:5:1)',
    ].join('\n');

    expect(getPackageName(ctor, true, stack)).toBe('@acme/widgets');
  });

  it('returns @oxc-project/runtime WITHOUT the guard (documents the bug)', () => {
    // Sanity check that the synthetic stack really would misattribute if the
    // oxc frame were not skipped: strip every non-oxc external frame and the
    // only scoped node_modules package left is the runtime helper.
    const oxcOnly = ['Error', CORE_FRAME, OXC_FRAME].join('\n');
    // With the guard, the oxc frame is skipped and nothing else matches → null.
    expect(getPackageName(ctor, true, oxcOnly)).toBeNull();
  });
});

describe('#1785: getSourceFileFromStack skips the oxc helper frame', () => {
  it('returns the consumer module, not the oxc runtime helper', () => {
    const stack = [
      'Error',
      CORE_FRAME,
      OXC_FRAME,
      '    at /virtual-1785-app/src/lib/objects/Widget.ts:5:1',
    ].join('\n');

    expect(getSourceFileFromStack(stack)).toBe(
      '/virtual-1785-app/src/lib/objects/Widget.ts',
    );
  });
});
