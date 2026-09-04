import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../tool-catalog.js';
import { checkKnowledgeFreshness } from './index.js';
import { checkMcpToolDocumentation } from './mcp-docs.js';

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

describe('development MCP documentation freshness', () => {
  let rootDir: string;
  let packageDir: string;
  let readme: string;
  let agents: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'smrt-mcp-docs-'));
    packageDir = join(rootDir, 'packages', 'smrt-dev-mcp');
    await mkdir(packageDir, { recursive: true });
    [readme, agents] = await Promise.all([
      readFile(join(packageRoot, 'README.md'), 'utf8'),
      readFile(join(packageRoot, 'AGENTS.md'), 'utf8'),
    ]);
    await Promise.all([
      writeFile(join(packageDir, 'README.md'), readme),
      writeFile(join(packageDir, 'AGENTS.md'), agents),
    ]);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('accepts the authored catalogs and schemas', () => {
    expect(checkMcpToolDocumentation(rootDir, packageDir, TOOLS)).toEqual([]);
  });

  it('detects missing and extra README tools', async () => {
    const mutated = readme.replace(
      '### `get-agent-skill`',
      '### `not-an-exported-tool`',
    );
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) => candidate.code === 'mcp-readme-tool-drift',
    );

    expect(issue).toMatchObject({
      severity: 'error',
      file: 'packages/smrt-dev-mcp/README.md',
      packageName: '@happyvertical/smrt-dev-mcp',
    });
    expect(issue?.message).toContain('missing: get-agent-skill');
    expect(issue?.message).toContain('extra: not-an-exported-tool');
  });

  it('detects duplicate README tool headings', async () => {
    const heading = '### `get-agent-skill`';
    const mutated = readme.replace(heading, `${heading}\n\n${heading}`);
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) => candidate.code === 'mcp-readme-tool-drift',
    );

    expect(issue?.message).toContain('duplicates: get-agent-skill');
  });

  it('detects duplicate exported tool definitions', () => {
    const duplicateTools = [...TOOLS, TOOLS[0]];

    const issue = checkMcpToolDocumentation(
      rootDir,
      packageDir,
      duplicateTools,
    ).find((candidate) => candidate.code === 'mcp-readme-tool-drift');

    expect(issue?.message).toContain(`exported duplicates: ${TOOLS[0]?.name}`);
  });

  it('detects a missing README input parameter', async () => {
    const detailRow =
      "| `detail` | `'summary' \\| 'full' \\| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |\n";
    const mutated = readme.replace(detailRow, '');
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) =>
        candidate.code === 'mcp-readme-schema-drift' &&
        candidate.message.includes('build-review-context'),
    );

    expect(issue?.message).toContain('missing: detail');
  });

  it('detects an extra README input parameter', async () => {
    const expected =
      '| `className` | `string` | Yes | Class name (PascalCase) |';
    const mutated = readme.replace(
      expected,
      `${expected}\n| \`notInSchema\` | \`string\` | No | Stale parameter |`,
    );
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) =>
        candidate.code === 'mcp-readme-schema-drift' &&
        candidate.message.includes('generate-smrt-class'),
    );

    expect(issue?.message).toContain('extra: notInSchema');
  });

  it('detects duplicate README input parameters', async () => {
    const row = '| `className` | `string` | Yes | Class name (PascalCase) |';
    const mutated = readme.replace(row, `${row}\n${row}`);
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) =>
        candidate.code === 'mcp-readme-schema-drift' &&
        candidate.message.includes('generate-smrt-class'),
    );

    expect(issue?.message).toContain('duplicates: className');
  });

  it('detects README input type and enum drift', async () => {
    const className =
      '| `className` | `string` | Yes | Class name (PascalCase) |';
    const detail =
      "| `detail` | `'summary' \\| 'full'` | No | Default `summary`. `full` returns field, schema, and method detail |";
    const mutated = readme
      .replace(
        className,
        '| `className` | `number` | Yes | Class name (PascalCase) |',
      )
      .replace(
        detail,
        "| `detail` | `'summary' \\| 'complete'` | No | Stale enum |",
      );
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issues = checkMcpToolDocumentation(rootDir, packageDir, TOOLS);
    expect(
      issues.find((candidate) =>
        candidate.message.includes('generate-smrt-class'),
      )?.message,
    ).toContain('className expected string but documented number');
    expect(
      issues.find((candidate) =>
        candidate.message.includes('introspect-project'),
      )?.message,
    ).toContain(
      "detail expected 'summary' | 'full' but documented 'summary' | 'complete'",
    );
  });

  it('detects README requiredness drift', async () => {
    const expected =
      '| `className` | `string` | Yes | Class name (PascalCase) |';
    const mutated = readme.replace(
      expected,
      '| `className` | `string` | No | Class name (PascalCase) |',
    );
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) =>
        candidate.code === 'mcp-readme-schema-drift' &&
        candidate.message.includes('generate-smrt-class'),
    );

    expect(issue?.message).toContain(
      'className expected Yes but documented No',
    );
  });

  it('detects AGENTS.md tool catalog drift', async () => {
    const row =
      '| `get-agent-skill` | Returns a bundled agent skill as Markdown plus optional references |\n';
    const mutated = agents.replace(row, '');
    expect(mutated).not.toBe(agents);
    await writeFile(join(packageDir, 'AGENTS.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) => candidate.code === 'mcp-agents-tool-drift',
    );

    expect(issue?.message).toContain('missing: get-agent-skill');
  });

  it('detects duplicate AGENTS.md tool rows', async () => {
    const row =
      '| `get-agent-skill` | Returns a bundled agent skill as Markdown plus optional references |';
    const mutated = agents.replace(row, `${row}\n${row}`);
    expect(mutated).not.toBe(agents);
    await writeFile(join(packageDir, 'AGENTS.md'), mutated);

    const issue = checkMcpToolDocumentation(rootDir, packageDir, TOOLS).find(
      (candidate) => candidate.code === 'mcp-agents-tool-drift',
    );

    expect(issue?.message).toContain('duplicates: get-agent-skill');
  });

  it('reports schema drift through the strict knowledge gate', async () => {
    await Promise.all([
      writeFile(
        join(rootDir, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n",
      ),
      writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-dev-mcp',
          version: '1.0.0',
          private: true,
          type: 'module',
        }),
      ),
      writeFile(join(packageDir, 'CLAUDE.md'), '@AGENTS.md\n'),
    ]);
    const detailRow =
      "| `detail` | `'summary' \\| 'full' \\| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |\n";
    const mutated = readme.replace(detailRow, '');
    expect(mutated).not.toBe(readme);
    await writeFile(join(packageDir, 'README.md'), mutated);

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'mcp-readme-schema-drift',
          file: 'packages/smrt-dev-mcp/README.md',
        }),
      ]),
    );
  });
});
