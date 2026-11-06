import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  buildComponentModels,
  checkBundle,
  emitFrontmatter,
  parsePage,
  planBundle,
  writeBundle,
} from './knowledge-okf.ts';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-okf-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakePackage(root, name, overrides = {}) {
  const dir = name.replace(/^@[^/]+\/smrt-/, '');
  const directory = join(root, 'packages', dir);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, description: `The ${dir} package` }),
  );
  return {
    name,
    version: '1.2.3',
    kind: 'smrt',
    directory,
    relativeDirectory: `packages/${dir}`,
    exportKeys: ['.'],
    smrtDependencies: [],
    sdkDependencies: [],
    docSource: 'AGENTS.md',
    agentDocSha256: 'a'.repeat(64),
    moduleDocs: [],
    objects: [],
    mcpTools: [],
    agentSurface: undefined,
    objectSource: 'none',
    isPrivate: false,
    isInstalledDependency: false,
    isWorkspaceRoot: false,
    ...overrides,
  };
}

function indexOf(...packages) {
  return { smrtPackages: packages };
}

const NOW = new Date('2026-11-05T12:00:00.000Z');

function setup(t, extra = {}) {
  const root = workspace(t);
  const jobs = fakePackage(root, '@happyvertical/smrt-jobs', {
    smrtDependencies: ['@happyvertical/smrt-core'],
    ...extra,
  });
  const core = fakePackage(root, '@happyvertical/smrt-core');
  const bundleDir = join(root, 'docs/knowledge');
  return { root, bundleDir, jobs, core };
}

function intent(id) {
  return { id, description: `Intent ${id}`, sourceFile: 'src/intents.ts' };
}

test('emitFrontmatter is deterministic YAML that parses back', () => {
  const text = emitFrontmatter({
    type: 'Component',
    title: 'a "quoted": title',
    empty: [],
    generated: { by: 'x', at: '2026-11-05T12:00:00Z' },
    sources: [{ id: 'one', resource: 'https://example.com/a' }],
  });
  assert.equal(
    text,
    [
      '---',
      'type: "Component"',
      'title: "a \\"quoted\\": title"',
      'empty: []',
      'generated:',
      '  by: "x"',
      '  at: "2026-11-05T12:00:00Z"',
      'sources:',
      '  - id: "one"',
      '    resource: "https://example.com/a"',
      '---',
      '',
    ].join('\n'),
  );
  const parsed = parsePage(`${text}\nbody\n`);
  assert.equal(parsed.frontmatter.title, 'a "quoted": title');
  assert.deepEqual(parsed.frontmatter.generated, {
    by: 'x',
    at: '2026-11-05T12:00:00Z',
  });
  assert.equal(parsed.frontmatter.sources[0].id, 'one');
  assert.equal(parsed.body, '\nbody\n');
});

test('component pages carry the issue frontmatter and only generator evidence levels', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  const models = buildComponentModels(
    indexOf({ ...jobs, objectSource: 'domain-artifact' }, core),
  );
  writeBundle(models, bundleDir, NOW);
  const page = parsePage(
    readFileSync(join(bundleDir, 'components/smrt-jobs.md'), 'utf8'),
  );
  const fm = page.frontmatter;
  assert.equal(fm.type, 'Component');
  assert.equal(fm.audience, 'internal');
  assert.equal(fm.package_version, undefined);
  assert.match(fm.source_revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fm.generated.at, '2026-11-05T12:00:00Z');
  assert.ok(fm.sources.length >= 2);
  assert.ok(
    ['manifest-described', 'source-inspected'].includes(fm.evidence_level),
  );
  assert.equal('stale_after' in fm, false);
  assert.match(page.body, /\[smrt-core\]\(\/components\/smrt-core\.md\)/);
  const root = readFileSync(join(bundleDir, 'index.md'), 'utf8');
  assert.ok(
    root.indexOf('/intents/index.md') < root.indexOf('/components/index.md'),
  );
});

test('generation is deterministic and keeps generated.at while content is unchanged', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  const models = buildComponentModels(indexOf(jobs, core));
  const first = writeBundle(models, bundleDir, NOW);
  assert.equal(first.written, 4);
  const before = [...planBundle(models, bundleDir, NOW)];
  const second = writeBundle(
    models,
    bundleDir,
    new Date('2027-01-01T00:00:00Z'),
  );
  assert.equal(second.written, 0);
  assert.deepEqual(
    [...planBundle(models, bundleDir, new Date('2030-01-01T00:00:00Z'))],
    before,
  );
  assert.deepEqual(checkBundle(models, bundleDir), []);
});

test('foreign models and tools in a development aggregate do not stale its component page (#4719)', (t) => {
  const { jobs, core } = setup(t);
  const ownModel = { className: 'Job', qualifiedName: `${jobs.name}:Job` };
  const legacyModel = { className: 'LegacyJob' };
  const ownTool = { name: 'job_list', sourceObject: ownModel.qualifiedName };
  const customTool = { name: 'refresh_jobs', sourceObject: '' };
  const local = {
    ...jobs,
    objectSource: 'domain-artifact',
    objects: [ownModel, legacyModel],
    mcpTools: [ownTool, customTool],
  };
  const aggregate = {
    ...local,
    objects: [...local.objects, { className: 'Asset', qualifiedName: `${core.name}:Asset` }],
    mcpTools: [...local.mcpTools, { name: 'asset_list', sourceObject: `${core.name}:Asset` }],
  };
  assert.deepEqual(
    buildComponentModels(indexOf(aggregate, core)),
    buildComponentModels(indexOf(local, core)),
  );
});

test('adding one intent changes only that package page and moves its pin', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  const before = buildComponentModels(indexOf(jobs, core));
  writeBundle(before, bundleDir, NOW);
  const baseline = planBundle(before, bundleDir, NOW);

  const changed = {
    ...jobs,
    objectSource: 'domain-artifact',
    agentSurface: {
      intents: [intent('jobs.run')],
      playbooks: [],
      diagnostics: [],
    },
  };
  const after = buildComponentModels(indexOf(changed, core));
  const later = planBundle(after, bundleDir, new Date('2026-12-01T00:00:00Z'));
  const differing = [...later.keys()].filter(
    (key) => later.get(key) !== baseline.get(key),
  );
  assert.deepEqual(differing, ['components/smrt-jobs.md']);
  assert.match(later.get('components/smrt-jobs.md'), /jobs\.run/);

  assert.deepEqual(
    checkBundle(after, bundleDir).map((issue) => [issue.code, issue.file]),
    [['okf-page-stale', 'docs/knowledge/components/smrt-jobs.md']],
  );
});

test('an AGENTS hash or dependency change turns the pin stale', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  writeBundle(buildComponentModels(indexOf(jobs, core)), bundleDir, NOW);
  for (const override of [
    { agentDocSha256: 'b'.repeat(64) },
    { smrtDependencies: [] },
  ]) {
    const issues = checkBundle(
      buildComponentModels(indexOf({ ...jobs, ...override }, core)),
      bundleDir,
    );
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ['okf-page-stale'],
      JSON.stringify(override),
    );
  }
  // Nothing about the inputs changed, so the check stays green regardless of
  // how much later it runs or which commit the tree is on.
  assert.deepEqual(
    checkBundle(buildComponentModels(indexOf(jobs, core)), bundleDir),
    [],
  );
});

test('a version-only change keeps the same source_revision', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  const [before] = buildComponentModels(indexOf(jobs, core));
  const [after] = buildComponentModels(
    indexOf({ ...jobs, version: '9.9.9' }, core),
  );
  assert.equal(after.sourceRevision, before.sourceRevision);
  writeBundle(buildComponentModels(indexOf(jobs, core)), bundleDir, NOW);
  assert.deepEqual(
    checkBundle(
      buildComponentModels(indexOf({ ...jobs, version: '9.9.9' }, core)),
      bundleDir,
    ),
    [],
  );
});

test('hand edits, missing and extra generated pages fail the check', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  const models = buildComponentModels(indexOf(jobs, core));
  writeBundle(models, bundleDir, NOW);

  const page = join(bundleDir, 'components/smrt-jobs.md');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, `${original}\nHand-written note.\n`);
  assert.deepEqual(
    checkBundle(models, bundleDir).map((issue) => issue.code),
    ['okf-page-edited'],
  );
  writeFileSync(page, original);

  const ghost = join(bundleDir, 'components/smrt-ghost.md');
  writeFileSync(ghost, '---\ntype: Component\n---\n');
  assert.deepEqual(
    checkBundle(models, bundleDir).map((issue) => issue.code),
    ['okf-page-extra'],
  );
  rmSync(ghost);

  rmSync(join(bundleDir, 'components/smrt-core.md'));
  assert.deepEqual(
    checkBundle(models, bundleDir).map((issue) => issue.code),
    ['okf-page-missing'],
  );
});

test('hand-authored pages need a type and every absolute link must resolve', (t) => {
  const { bundleDir, jobs, core } = setup(t);
  const models = buildComponentModels(indexOf(jobs, core));
  writeBundle(models, bundleDir, NOW);

  const write = (path, text) => {
    mkdirSync(dirname(join(bundleDir, path)), { recursive: true });
    writeFileSync(join(bundleDir, path), text);
  };
  write(
    'intents/background-work.md',
    [
      '---',
      'type: Intent',
      '---',
      '',
      'Use [jobs](/components/smrt-jobs.md).',
      '`[inline](/components/nope-inline.md)` is code.',
      '```',
      '[fenced](/components/nope-fenced.md)',
      '```',
      '',
    ].join('\n'),
  );
  write(
    'intents/index.md',
    '# Intents\n\n* [Background](/intents/background-work.md)\n',
  );
  assert.deepEqual(checkBundle(models, bundleDir), []);

  write(
    'intents/scheduled-runs.md',
    '---\ntype: Intent\n---\nSee [x](/components/smrt-missing.md) and [y](/intents/nope.md#frag).\n',
  );
  write('solutions/untyped.md', '---\ntype: ""\n---\nbody\n');
  write('solutions/broken.md', '---\ntype: [unclosed\n---\nbody\n');
  const summary = checkBundle(models, bundleDir)
    .map((issue) => `${issue.code} ${issue.file}`)
    .sort();
  assert.deepEqual(summary, [
    'okf-dangling-link docs/knowledge/intents/scheduled-runs.md',
    'okf-dangling-link docs/knowledge/intents/scheduled-runs.md',
    'okf-frontmatter-invalid docs/knowledge/solutions/broken.md',
    'okf-frontmatter-invalid docs/knowledge/solutions/untyped.md',
  ]);
});

test('two packages mapping to one concept ID fail loudly', (t) => {
  const root = workspace(t);
  const a = fakePackage(root, '@happyvertical/smrt-dup');
  const b = fakePackage(root, '@other/smrt-dup', {
    relativeDirectory: 'packages/other',
  });
  assert.throws(() => buildComponentModels(indexOf(a, b)), /collision/);
});
