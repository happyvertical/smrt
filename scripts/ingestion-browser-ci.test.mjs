import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/test-suite.yml', import.meta.url), 'utf8');
const filter = workflow.match(/^            workbench:\n((?:              - .*\n)+)/m)?.[1];
const browserJob = workflow.match(/^  workbench-browser:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];

test('ingestion and shared UI changes select the maintained browser lane', () => {
  assert.ok(filter, 'existing affected browser filter must be present');
  const patterns = [...filter.matchAll(/- '([^']+)'/g)].map((match) => match[1]);
  for (const file of ['packages/ingestion/src/server.ts', 'packages/ingestion/src/svelte/components/IntakeReview.svelte', 'packages/ingestion/e2e/review/review.spec.ts', 'packages/smrt-ui/src/lib/components/Button.svelte', '.github/workflows/test-suite.yml']) {
    assert.ok(patterns.some((pattern) => matchesGlob(file, pattern)), `${file} must select browser validation`);
  }
  assert.equal(patterns.some((pattern) => matchesGlob('docs/unrelated.md', pattern)), false);
});

test('existing affected/full browser conditions build and enforce ingestion with failure evidence', () => {
  assert.ok(browserJob, 'existing browser job remains required');
  assert.match(browserJob, /inputs.mode == 'affected'/);
  assert.match(browserJob, /needs.affected-scope.outputs.workbench == 'true'/);
  assert.match(browserJob, /inputs.mode == 'full' && needs.build.result == 'success'/);
  const build = browserJob.indexOf("--filter='@happyvertical/smrt-ingestion...'");
  const command = browserJob.indexOf('run: pnpm --filter @happyvertical/smrt-ingestion test:e2e');
  assert.ok(build >= 0 && command > build, 'normal owning dependency build must precede browser command');
  assert.doesNotMatch(browserJob, /continue-on-error:/);
  assert.match(browserJob, /Upload ingestion review failure evidence\n\s+if: failure\(\)/);
  assert.match(browserJob, /path: packages\/ingestion\/test-results\/review/);
});
