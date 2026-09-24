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

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getPackageName } from '../../manifest/manifest-loader.js';
import type { SmrtObjectConstructor } from '../../registry/types.js';
import {
  DECORATOR_RUNTIME_PACKAGES,
  isDecoratorRuntimeFramePath,
  isDecoratorRuntimePackageName,
  isModuleRunnerFramePath,
} from '../../utils/stack-frames.js';
import { getSourceFileFromStack } from '../shared-state.js';

// A pnpm-resolved oxc runtime helper frame — the shape oxc's legacy-decorator
// lowering inserts when it applies a class decorator.
const OXC_FRAME =
  '    at applyDecoratedDescriptor (/nonexistent-1785/node_modules/.pnpm/@oxc-project+runtime@0.138.0/node_modules/@oxc-project/runtime/src/helpers/esm/applyDecoratedDescriptor.js:12:3)';
// A smrt-core internal frame (the registration entry point). Core frames are
// recognized by this core's real package directory, not by a `packages/core`
// substring a consumer's own workspace package could also contain (#3110).
const CORE_FRAME = `    at register (${fileURLToPath(
  new URL('../class-registration.ts', import.meta.url),
)}:581:10)`;

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

  it('matches the Vite virtual-module id of the oxc helper (#3098)', () => {
    // Vitest/Vite dev serve the helper as `\0@oxc-project+runtime@<v>/...`
    // relative to the project root; unskipped, it attributed every class to
    // the root package.
    expect(
      isDecoratorRuntimeFramePath(
        '/repo/packages/ledgers/\0@oxc-project+runtime@0.138.0/helpers/esm/decorate.js',
      ),
    ).toBe(true);
    expect(
      isDecoratorRuntimeFramePath('/repo/app/src/oxc-project+runtime@1/x.ts'),
    ).toBe(false);
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

describe('#3098: getPackageName under a module runner (Vitest, Vite SSR)', () => {
  const ctor = { name: 'Widget' } as unknown as SmrtObjectConstructor;
  // Real files, so the package.json walk (method 3) resolves them.
  const declaringModule = fileURLToPath(
    new URL('../../../../ledgers/src/models/Account.ts', import.meta.url),
  );
  const coreTestModule = fileURLToPath(
    new URL('./widget-registry.test.ts', import.meta.url),
  );
  const VIRTUAL_OXC_FRAME =
    '    at __decorate (/repo/packages/app/\0@oxc-project+runtime@0.138.0/helpers/esm/decorate.js:17:22)';
  const RUNNER_FRAME =
    '    at file:///repo/node_modules/.pnpm/@vitest+runner@4.1.10/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11';

  it('skips the Vite virtual-module oxc helper and reads the anonymous declaring frame', () => {
    const stack = [
      'Error',
      CORE_FRAME,
      VIRTUAL_OXC_FRAME,
      `    at ${declaringModule}:165:44`,
      RUNNER_FRAME,
    ].join('\n');

    expect(getPackageName(ctor, true, stack)).toBe(
      '@happyvertical/smrt-ledgers',
    );
  });

  it('never attributes a class to the test or module runner', () => {
    expect(isModuleRunnerFramePath(RUNNER_FRAME)).toBe(true);
    expect(
      isModuleRunnerFramePath(
        '/repo/node_modules/vite/dist/node/module-runner.js',
      ),
    ).toBe(true);
    expect(isModuleRunnerFramePath(declaringModule)).toBe(false);
    const runnerOnly = ['Error', CORE_FRAME, RUNNER_FRAME].join('\n');
    expect(getPackageName(ctor, true, runnerOnly)).toBeNull();
  });

  it('attributes a caller whose file name merely contains "registry"', () => {
    const stack = ['Error', CORE_FRAME, `    at ${coreTestModule}:9:1`].join(
      '\n',
    );
    expect(getPackageName(ctor, true, stack)).toBe('@happyvertical/smrt-core');
  });
});
