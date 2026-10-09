import { build } from 'vite';
const banned = /^(node:|pg$|@happyvertical\/(pdf|ocr|speech|ai)$)/;
await build({
  configFile: false,
  logLevel: 'error',
  plugins: [{ name: 'ingestion-browser-boundary', resolveId(id) { if (banned.test(id)) throw new Error(`Server dependency in browser graph: ${id}`); } }],
  build: { write: false, lib: { entry: ['dist/index.js', 'dist/dto.js'], formats: ['es'] }, minify: false },
  resolve: { conditions: ['browser', 'import', 'default'] },
});

// A consumer resolves the published DTO subpath without Node globals/types.
const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { execFileSync } = await import('node:child_process');
const consumer = await mkdtemp(join(tmpdir(), 'ingestion-browser-types-'));
try {
  await mkdir(join(consumer, 'node_modules', '@happyvertical'), { recursive: true });
  await symlink(resolve('.'), join(consumer, 'node_modules', '@happyvertical', 'smrt-ingestion'), 'dir');
  await writeFile(join(consumer, 'index.ts'), `import type { IntakeReviewHost, ItemReviewView, LogicalSplitInput, ReviewPage, GenerationOutput, ProposalCatalogEntry, PreviewGeneratedInput, ActionResult, ExecutionCeiling, IntakeValues, PlanReview, PreviewPlanInput, PreviewProposalInput, ProposalReview, ResultReference, ReviewInput } from '@happyvertical/smrt-ingestion/dto';
export type BrowserMessages = [IntakeReviewHost, ItemReviewView, LogicalSplitInput, ReviewPage, GenerationOutput, ProposalCatalogEntry, PreviewGeneratedInput, ActionResult, ExecutionCeiling, IntakeValues, PlanReview, PreviewPlanInput, PreviewProposalInput, ProposalReview, ResultReference, ReviewInput];
const decision: ReviewInput['decision'] = 'approve';
document.body.dataset.decision = decision;
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM'], types: [], strict: true, noEmit: true }, files: ['index.ts'] }));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--project', join(consumer, 'tsconfig.json')], { stdio: 'pipe' });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
