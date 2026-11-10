import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectHandRolled } from './intent-detector.js';
import { parseIntentIndex } from './intent-index.js';
import { renderReviewSummary, runReviewCli } from './review-cli.js';
import {
  defaultIntentIndexCandidates,
  reviewSmrtProject,
} from './review-smrt-project.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '..', '..', 'test-fixtures');
const fixtureIndex = join(fixtures, 'intents', 'index.md');
const monorepoIndex = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'knowledge',
  'intents',
  'index.md',
);

interface Review {
  findings: {
    area: string;
    code: string;
    file: string;
    intentPage: string;
    componentPages: string[];
    evidence: { filePath: string; line: number }[];
  }[];
  duplicateDetection: { indexPath: string | null; notes: string[] };
}

async function review(args: Record<string, unknown>): Promise<Review> {
  return JSON.parse(await reviewSmrtProject(args));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-intent-dupes-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const HOSTILE_INDEX = [
  '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
  '| --- | --- | --- | --- | --- |',
  '| Hostile | [hostile](/intents/hostile.md) | [smrt-jobs](/components/smrt-jobs.md) | `X` | `regex:(a+)+$`; `call:setInterval` |',
].join('\n');

const SMRT_PACKAGE_JSON = JSON.stringify({
  name: '@test/consumer',
  dependencies: { '@happyvertical/smrt-core': '^0.60.0' },
});

describe('parseIntentIndex', () => {
  it('parses rows, home packages, concept ids and signal tokens', () => {
    const rows = parseIntentIndex(
      [
        '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
        '| --- | --- | --- | --- | --- |',
        '| Jobs | [jobs](/intents/jobs.md) | [smrt-jobs](/components/smrt-jobs.md), [smrt-core](/components/smrt-core.md) | `bg()` | `import:bullmq`; `regex:a\\|b`; `call:setInterval` |',
      ].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].intentPage).toBe('/intents/jobs.md');
    expect(rows[0].homePackages.map((home) => home.packageName)).toEqual([
      '@happyvertical/smrt-jobs',
      '@happyvertical/smrt-core',
    ]);
    expect(rows[0].homePackages[0].componentPage).toBe(
      '/components/smrt-jobs.md',
    );
    expect(rows[0].signals.map((signal) => signal.raw)).toEqual([
      'import:bullmq',
      'regex:a|b',
      'call:setInterval',
    ]);
  });

  it('parses every row of the monorepo intent index', async () => {
    const { readFile } = await import('node:fs/promises');
    const rows = parseIntentIndex(await readFile(monorepoIndex, 'utf-8'));
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) {
      expect(row.intentPage).toMatch(/^\/intents\/[a-z-]+\.md$/);
      expect(row.homePackages.length).toBeGreaterThan(0);
      expect(row.signals.length).toBeGreaterThan(0);
    }
  });

  it('returns no rows when there is no table', () => {
    expect(parseIntentIndex('# nothing here')).toEqual([]);
  });
});

describe('duplicate detection fixtures', () => {
  it('flags exactly the hand-rolled queue, cron loop and mailer', async () => {
    const result = await review({
      directory: join(fixtures, 'consumer-hand-rolled'),
      intentIndexPath: fixtureIndex,
    });
    const found = result.findings.filter(
      (finding) => finding.area === 'duplicate-detection',
    );
    expect(found.map((finding) => finding.intentPage).sort()).toEqual([
      '/intents/background-work.md',
      '/intents/outbound-messages.md',
      '/intents/scheduled-runs.md',
    ]);
    expect(result.findings).toHaveLength(3);
    const byIntent = Object.fromEntries(
      found.map((finding) => [finding.intentPage, finding]),
    );
    expect(byIntent['/intents/background-work.md'].file).toBe('src/queue.ts:1');
    expect(byIntent['/intents/scheduled-runs.md'].file).toBe('src/cron.ts:1');
    expect(byIntent['/intents/outbound-messages.md'].file).toBe(
      'src/mailer.ts:1',
    );
    expect(byIntent['/intents/scheduled-runs.md'].componentPages).toEqual([
      '/components/smrt-jobs.md',
      '/components/smrt-agents.md',
    ]);
  });

  it('produces the same three findings against the monorepo index', async () => {
    const result = await review({
      directory: join(fixtures, 'consumer-hand-rolled'),
      intentIndexPath: monorepoIndex,
    });
    expect(result.findings.map((finding) => finding.intentPage).sort()).toEqual(
      [
        '/intents/background-work.md',
        '/intents/outbound-messages.md',
        '/intents/scheduled-runs.md',
      ],
    );
  });

  it('flags a hand-written home-directory token store', async () => {
    for (const intentIndexPath of [fixtureIndex, monorepoIndex]) {
      const result = await review({
        directory: join(fixtures, 'consumer-hand-rolled-credentials'),
        intentIndexPath,
      });
      // Writing a file also trips the separate storage-bypass heuristic.
      const found = result.findings.filter(
        (finding) => finding.area === 'duplicate-detection',
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        area: 'duplicate-detection',
        code: 'hand-rolled-local-credentials-and-owner-signin',
        intentPage: '/intents/local-credentials-and-owner-signin.md',
        componentPages: [
          '/components/smrt-app-runtime.md',
          '/components/smrt-users.md',
        ],
      });
      // The token file path and the fixed `expiresIn` lifetime.
      expect(
        found[0].evidence.map((item) => [item.filePath, item.line]),
      ).toEqual([
        ['src/token-store.ts', 5],
        ['src/token-store.ts', 9],
      ]);
    }
  });

  it('produces no findings for a clean consumer', async () => {
    const result = await review({
      directory: join(fixtures, 'consumer-clean'),
      intentIndexPath: fixtureIndex,
    });
    expect(result.findings).toEqual([]);
  });

  it('renders findings as a markdown check summary', async () => {
    const result = await review({
      directory: join(fixtures, 'consumer-hand-rolled'),
      intentIndexPath: fixtureIndex,
    });
    const summary = renderReviewSummary(result as never);
    expect(summary).toContain('3 advisory finding(s)');
    expect(summary).toContain('`src/cron.ts:1`');
    expect(summary).toContain('`/intents/scheduled-runs.md`');
  });
});

describe('table-driven behaviour', () => {
  it('flags a NEW synthetic index row with no code change', async () => {
    const dir = await tempProject({
      'package.json': SMRT_PACKAGE_JSON,
      'src/a.ts':
        "import widgets from 'fancy-widgets';\nexport default widgets;\n",
      'index.md': [
        '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
        '| --- | --- | --- | --- | --- |',
        '| Widgets | [widgets](/intents/widgets.md) | [smrt-widgets](/components/smrt-widgets.md) | `Widget` | `import:fancy-widgets` |',
      ].join('\n'),
    });
    const result = await review({
      directory: dir,
      intentIndexPath: 'index.md',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: 'hand-rolled-widgets',
      intentPage: '/intents/widgets.md',
      componentPages: ['/components/smrt-widgets.md'],
      file: 'src/a.ts:1',
    });
  });

  it('ignores an intent index in the reviewed tree by default', async () => {
    const dir = await tempProject({
      'package.json': SMRT_PACKAGE_JSON,
      'src/a.ts': 'setInterval(() => undefined, 1000);\n',
      'docs/knowledge/intents/index.md': HOSTILE_INDEX,
      '.agents/smrt-knowledge/intents/index.md': HOSTILE_INDEX,
    });
    const result = await review({ directory: dir });
    expect(result.duplicateDetection.indexPath).not.toBeNull();
    expect(result.duplicateDetection.indexPath).not.toContain(dir);
    // The consumer's catastrophic-regex row never ran.
    expect(result.findings.map((finding) => finding.code)).not.toContain(
      'hand-rolled-hostile',
    );
  });

  it('prefers the packaged index over the monorepo one', async () => {
    const root = await tempProject({
      'pnpm-workspace.yaml': 'packages: []\n',
      'docs/knowledge/intents/index.md': 'monorepo',
      'packages/pkg/dist/knowledge/intents/index.md': 'packaged',
    });
    const packageRoot = join(root, 'packages', 'pkg');
    expect(defaultIntentIndexCandidates(packageRoot)).toEqual([
      join(packageRoot, 'dist', 'knowledge', 'intents', 'index.md'),
      join(root, 'docs', 'knowledge', 'intents', 'index.md'),
    ]);
    // An installed package (not under <repo>/packages) has only the packaged index.
    expect(
      defaultIntentIndexCandidates(
        join(root, 'node_modules', '@happyvertical', 'smrt-dev-mcp'),
      ),
    ).toHaveLength(1);
  });

  it('uses the packaged index when present, ahead of an explicit-free default', async () => {
    const pkg = await tempProject({
      'dist/knowledge/intents/index.md': [
        '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
        '| --- | --- | --- | --- | --- |',
        '| Schedules | [scheduled-runs](/intents/scheduled-runs.md) | [smrt-jobs](/components/smrt-jobs.md) | `ScheduleRunner` | `call:setInterval` |',
      ].join('\n'),
    });
    const dir = await tempProject({
      'package.json': SMRT_PACKAGE_JSON,
      'src/a.ts': 'setInterval(() => undefined, 1000);\n',
    });
    const result = await review({ directory: dir, packageRoot: pkg });
    expect(result.duplicateDetection.indexPath).toBe(
      join(pkg, 'dist', 'knowledge', 'intents', 'index.md'),
    );
    expect(result.findings.map((finding) => finding.file)).toEqual([
      'src/a.ts:1',
    ]);
  });

  it('skips duplicate detection with a note when no index exists', async () => {
    const dir = await tempProject({
      'package.json': SMRT_PACKAGE_JSON,
      'src/a.ts': 'setInterval(() => undefined, 1000);\n',
    });
    const result = await review({
      directory: dir,
      packageRoot: await tempProject({}),
    });
    expect(result.findings).toEqual([]);
    expect(result.duplicateDetection.indexPath).toBeNull();
    expect(result.duplicateDetection.notes[0]).toMatch(/No intent index/);
  });

  it('review CLI exits non-zero with a stderr message when no index exists', async () => {
    const dir = await tempProject({
      'package.json': SMRT_PACKAGE_JSON,
      'src/a.ts': 'setInterval(() => undefined, 1000);\n',
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const code = await runReviewCli(
        ['--directory', dir, '--format', 'summary'],
        { packageRoot: await tempProject({}) },
      );
      expect(code).toBe(2);
      expect(String(stderr.mock.calls[0][0])).toMatch(/no intent index found/);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('is silent when the home package is imported', () => {
    const rows = parseIntentIndex(
      [
        '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
        '| --- | --- | --- | --- | --- |',
        '| Jobs | [jobs](/intents/jobs.md) | [smrt-jobs](/components/smrt-jobs.md) | `bg()` | `call:setInterval` |',
      ].join('\n'),
    );
    const file = {
      relativePath: 'a.ts',
      content: 'setInterval(f, 1);',
      imports: ['@happyvertical/smrt-jobs'],
    };
    expect(
      detectHandRolled(rows, [
        { relativePath: '.', installed: new Set(), files: [file] },
      ]),
    ).toEqual([]);
  });

  it('skips unknown signal kinds and invalid regexes with a note', () => {
    const rows = parseIntentIndex(
      [
        '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
        '| --- | --- | --- | --- | --- |',
        '| Jobs | [jobs](/intents/jobs.md) | [smrt-jobs](/components/smrt-jobs.md) | `bg()` | `future:thing`; `regex:(`; `call:setInterval` |',
      ].join('\n'),
    );
    const notes: string[] = [];
    const found = detectHandRolled(
      rows,
      [
        {
          relativePath: '.',
          installed: new Set(),
          files: [
            {
              relativePath: 'a.ts',
              content: 'setInterval(f, 1);',
              imports: [],
            },
          ],
        },
      ],
      { onNote: (note) => notes.push(note) },
    );
    expect(found).toHaveLength(1);
    expect(found[0].matchedSignals).toEqual(['call:setInterval']);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('future:thing');
    expect(notes[1]).toContain('regex:(');
  });

  it('flags decimal-declared money fields via decimal-field signals', () => {
    const rows = parseIntentIndex(
      [
        '| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |',
        '| --- | --- | --- | --- | --- |',
        '| Money | [money](/intents/money-and-rates.md) | [smrt-core](/components/smrt-core.md) | `amount = 0` | `decimal-field:*_cents`; `decimal-field:*_amount` |',
      ].join('\n'),
    );
    const content = [
      'class Invoice {',
      '  total_cents = 0.0;',
      '  taxAmount: number = 0.0;',
      '  count = 0;',
      '  rate = 0.0;',
      '}',
    ].join('\n');
    const [found] = detectHandRolled(rows, [
      {
        relativePath: '.',
        installed: new Set(),
        files: [{ relativePath: 'invoice.ts', content, imports: [] }],
      },
    ]);
    expect(found.evidence.map((item) => item.line)).toEqual([2, 3]);
  });
});
