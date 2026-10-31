/**
 * Simulates the #4128 race deterministically: a production build (as Turbo
 * runs for `pnpm typecheck`) rewrites `.smrt/manifest.json` AFTER the test
 * runner generated its test manifest and BEFORE any test worker reads it.
 * `globalSetup` runs in the runner process after plugin `configResolved()`
 * and before test files execute, which is exactly that window.
 *
 * The written manifest is production-shaped: it carries the package's
 * production `Widget` only, never the spec's inline `Gadget` fixture.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
const packageName = '@fixture/smrt-issue-4128-concurrent-build';

export const PRODUCTION_MANIFEST = `${JSON.stringify(
  {
    version: '1.0.0',
    timestamp: 0,
    moduleType: 'smrt',
    packageName,
    producedBy: 'issue-4128-concurrent-build',
    objects: {
      [`${packageName}:Widget`]: {
        name: 'widget',
        className: 'Widget',
        collection: 'widgets',
        filePath: 'src/models/widget.ts',
        packageName,
        fields: { label: { type: 'text', required: true } },
        methods: {},
      },
    },
  },
  null,
  2,
)}\n`;

export default function setup(): void {
  if (process.env.SMRT_FIXTURE_SKIP_CONCURRENT_BUILD === '1') return;
  mkdirSync(join(fixtureRoot, '.smrt'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.smrt/manifest.json'), PRODUCTION_MANIFEST);
}
