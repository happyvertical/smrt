/**
 * Consumer-workspace class identity (#3106, #3109, #3110).
 *
 * #3102 (0.51.25) made class identity package-strict. Consumers then broke
 * where a class's declaring package had to be derived from the stack:
 *
 * - under tsx / `--enable-source-maps`, installed smrt-core's frames report
 *   their source-mapped `.../smrt-core/src/...` paths, which the stack walk did
 *   not skip, so every class was attributed to `@happyvertical/smrt-core`
 *   (#3109; ergot's pnpm peer-variant copies of smrt-jobs `SmrtJob` then threw
 *   a class-name collision, #3110);
 * - a model declared in a workspace package that an app's manifest scans under
 *   the app's name (anytown's `packages/cloud-network`) registered under the
 *   workspace package with no fields in a Vite dev server, and a module reset
 *   that re-decorated it threw a class-name collision (#3110);
 * - a consumer class sharing a simple name with a dependency's class
 *   (`LicenseSale` in ergot's market-core and smrt-commerce) threw a
 *   collision, or in bundled output adopted the dependency's entry (#3106).
 *
 * These run in Vitest's module runner (the Vite SSR runner) against consumer
 * workspaces laid out on disk; `issue-3109-plain-node-consumer.test.ts` covers
 * the plain Node process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPackageName } from '../../manifest/manifest-loader.js';
import { isSmrtCoreFramePath } from '../../utils/stack-frames.js';
import { getSourceFileFromStack } from '../shared-state.js';
import type { SmrtObjectConstructor } from '../types.js';
import {
  type ConsumerWorkspace,
  createConsumerWorkspace,
} from './helpers/consumer-workspace.js';

describe('stack attribution under source maps (#3109, #3110)', () => {
  let ws: ConsumerWorkspace;
  let installedCore: string;

  beforeAll(() => {
    ws = createConsumerWorkspace('smrt-3109-stack');
    installedCore =
      'node_modules/.pnpm/@happyvertical+smrt-core@0.51.25_x/node_modules/@happyvertical/smrt-core';
    ws.writePackage(installedCore, '@happyvertical/smrt-core');
    ws.writePackage('apps/app', '@fixture/app');
    ws.write('apps/app/src/models/Network.ts', '');
  });
  afterAll(() => ws.dispose());

  // The stack a tsx script produced registering an app model on 0.51.25:
  // installed core frames, source-mapped to core's `src/`, above the app's.
  const tsxStack = () =>
    [
      'Error',
      `    at getPackageName (${ws.path(installedCore, 'src/manifest/manifest-loader.ts')}:534:38)`,
      `    at registerUntracked (${ws.path(installedCore, 'src/registry/class-registration.ts')}:783:28)`,
      `    at register (${ws.path(installedCore, 'src/registry/class-registration.ts')}:638:5)`,
      `    at ObjectRegistry.register (${ws.path(installedCore, 'dist/registry.js')}:622:3)`,
      `    at <anonymous> (file://${ws.path(installedCore, 'dist/registry.js')}:2505:19)`,
      `    at <anonymous> (file://${ws.path('apps/app/src/models/Network.ts')}:12:1)`,
      '    at ModuleJob.run (node:internal/modules/esm/module_job:569:25)',
    ].join('\n');

  it('skips source-mapped installed smrt-core frames', () => {
    expect(
      isSmrtCoreFramePath(
        ws.path(installedCore, 'src/registry/class-registration.ts'),
      ),
    ).toBe(true);
    expect(
      getPackageName(
        class Network {} as unknown as SmrtObjectConstructor,
        true,
        tsxStack(),
      ),
    ).toBe('@fixture/app');
  });

  it('reports the declaring file without a named frame parenthesis', () => {
    expect(getSourceFileFromStack(tsxStack())).toBe(
      ws.path('apps/app/src/models/Network.ts'),
    );
  });
});
