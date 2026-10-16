/**
 * `src/lib/smrt-version.ts` is generated from the installed smrt-core
 * (`pnpm version:smrt`, also the first step of `pnpm package`); the Export
 * page names that version in its CLI commands.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SMRT_VERSION } from '../src/lib/smrt-version.ts';

it('matches the installed @happyvertical/smrt-core', () => {
  const installed = JSON.parse(
    readFileSync(
      new URL(
        '../node_modules/@happyvertical/smrt-core/package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { version: string };
  expect(SMRT_VERSION, 'run pnpm version:smrt').toBe(installed.version);
});
