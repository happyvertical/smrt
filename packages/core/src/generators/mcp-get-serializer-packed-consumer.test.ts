/**
 * A serializer belongs to the app's model package, not to smrt-core. This
 * exercises the published Core package in a pnpm-installed consumer where
 * Commerce is available only to the consumer and uses its real import-only
 * root export shape.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = resolve(import.meta.dirname, '../..');
const workspaceRoot = resolve(packageDir, '../..');
const commercePackage = JSON.parse(
  readFileSync(
    resolve(workspaceRoot, 'packages/commerce/package.json'),
    'utf8',
  ),
) as { exports: unknown };

interface PackedConsumer {
  directory: string;
  cleanup: () => void;
}

interface PackedConsumerModule {
  createPackedConsumer(input: {
    root: string;
    packageNames: string[];
  }): PackedConsumer;
}

interface ConsumerReport {
  result: { source: string; title: string; permissions: string[] };
  missingExport: string;
  sourceFilePath: string;
  coreEntry: string;
  commerceEntry: string;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90_000,
  });
  const stdout = String(result.stdout);
  const stderr = String(result.stderr);
  expect(result.error, `${command} ${args.join(' ')}`).toBeUndefined();
  expect(
    result.status,
    `${command} ${args.join(' ')}\n${stdout}${stderr}`,
  ).toBe(0);
  return stdout;
}

describe('MCP get serializer packed consumer (#3937)', () => {
  let consumer: PackedConsumer | undefined;
  let result: ReturnType<typeof spawnSync>;

  beforeAll(async () => {
    // This helper packs Core and its workspace dependencies, then installs them
    // into a clean pnpm consumer. It is the repository's strict consumer-test
    // convention: no workspace alias is visible to the resulting process.
    const packedConsumerModule = pathToFileURL(
      resolve(workspaceRoot, 'scripts/packed-consumer.mjs'),
    ).href;
    const { createPackedConsumer } = (await import(
      packedConsumerModule
    )) as PackedConsumerModule;
    const liveCoreArtifact = join(packageDir, 'dist/database.js');
    const liveArtifactMtime = statSync(liveCoreArtifact).mtimeMs;
    consumer = createPackedConsumer({
      root: workspaceRoot,
      packageNames: ['@happyvertical/smrt-core'],
    });
    expect(statSync(liveCoreArtifact).mtimeMs).toBe(liveArtifactMtime);

    const commerceSource = join(consumer.directory, 'commerce-source');
    const tarballs = join(consumer.directory, 'tarballs');
    mkdirSync(join(commerceSource, 'dist'), { recursive: true });

    // Preserve Commerce's public import-only root export contract. The
    // implementation stays tiny so this regression isolates resolution rather
    // than Commerce's own runtime dependencies.
    writeFileSync(
      join(commerceSource, 'package.json'),
      JSON.stringify(
        {
          name: '@happyvertical/smrt-commerce',
          version: '0.0.0-test',
          type: 'module',
          exports: commercePackage.exports,
          files: ['dist'],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(commerceSource, 'dist/index.js'),
      `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

export class Invoice extends SmrtObject {}
Object.defineProperty(Invoice, '__smrtPackage__', {
  value: '@happyvertical/smrt-commerce',
});
smrt({
  mcp: {
    include: ['get'],
    serializers: {
      get: {
        importPath: '@happyvertical/smrt-commerce',
        exportName: 'serializeInvoiceMcpGet',
      },
    },
  },
})(Invoice);

export function serializeInvoiceMcpGet(item, options) {
  return {
    source: 'commerce',
    title: item.title,
    permissions: [...(options.permissions ?? [])],
  };
}
`,
    );
    run('pnpm', ['pack', '--pack-destination', tarballs], commerceSource);
    const commerceTarballs = readdirSync(tarballs)
      .filter((name) => name.startsWith('happyvertical-smrt-commerce-'))
      .map((name) => join(tarballs, name));
    expect(commerceTarballs).toHaveLength(1);

    const consumerPackagePath = join(consumer.directory, 'package.json');
    const consumerPackage = JSON.parse(
      readFileSync(consumerPackagePath, 'utf8'),
    ) as { dependencies: Record<string, string> };
    consumerPackage.dependencies['@happyvertical/smrt-commerce'] =
      `file:${commerceTarballs[0]}`;
    writeFileSync(
      consumerPackagePath,
      `${JSON.stringify(consumerPackage, null, 2)}\n`,
    );
    run(
      'pnpm',
      ['install', '--ignore-scripts', '--no-frozen-lockfile'],
      consumer.directory,
    );

    const launcherDirectory = join(
      resolve(consumer.directory, '..'),
      'launcher',
    );
    mkdirSync(
      join(launcherDirectory, 'node_modules/@happyvertical/smrt-commerce/dist'),
      {
        recursive: true,
      },
    );
    writeFileSync(
      join(
        launcherDirectory,
        'node_modules/@happyvertical/smrt-commerce/package.json',
      ),
      JSON.stringify({
        name: '@happyvertical/smrt-commerce',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    writeFileSync(
      join(
        launcherDirectory,
        'node_modules/@happyvertical/smrt-commerce/dist/index.js',
      ),
      `export function serializeInvoiceMcpGet() { return { source: 'wrong-cwd' }; }\n`,
    );
    const script = join(consumer.directory, 'run.mjs');
    writeFileSync(
      script,
      `import { ObjectRegistry } from '@happyvertical/smrt-core';
import { resolveMcpGetSerializer } from '@happyvertical/smrt-core/mcp-serializer';
import '@happyvertical/smrt-commerce';

const ownerRegistryKey = '@happyvertical/smrt-commerce:Invoice';
const sourceFilePath = ObjectRegistry.getClass(ownerRegistryKey)?.sourceFilePath;
if (!sourceFilePath) throw new Error('Installed Invoice did not retain its defining module path');

const serializer = await resolveMcpGetSerializer({
  importPath: '@happyvertical/smrt-commerce',
  exportName: 'serializeInvoiceMcpGet',
}, { ownerRegistryKey });
let missingExport = '';
try {
  await resolveMcpGetSerializer({
    importPath: '@happyvertical/smrt-commerce',
    exportName: 'missingSerializer',
  }, { ownerRegistryKey });
} catch (error) {
  missingExport = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify({
  result: await serializer({ title: 'legacy invoice' }, { permissions: ['invoices.read'] }),
  missingExport,
  sourceFilePath,
  coreEntry: import.meta.resolve('@happyvertical/smrt-core/mcp-serializer'),
  commerceEntry: import.meta.resolve('@happyvertical/smrt-commerce'),
}));
`,
    );
    result = spawnSync(process.execPath, [script], {
      cwd: launcherDirectory,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90_000,
    });
  }, 240_000);

  afterAll(() => {
    consumer?.cleanup();
    consumer = undefined;
  });

  it('ships every relative JavaScript import in the installed tarball (#4008)', () => {
    if (!consumer) throw new Error('Packed consumer was not created');
    const dist = join(
      consumer.directory,
      'node_modules/@happyvertical/smrt-core/dist',
    );
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.name.endsWith('.js')) {
          const source = ts.createSourceFile(
            file,
            readFileSync(file, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
          );
          const check = (node: ts.Node) => {
            const specifier =
              ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
                ? node.moduleSpecifier
                : ts.isCallExpression(node) &&
                    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                      (ts.isIdentifier(node.expression) &&
                        node.expression.text === 'require'))
                  ? node.arguments[0]
                  : undefined;
            if (
              specifier &&
              ts.isStringLiteral(specifier) &&
              specifier.text.startsWith('.')
            ) {
              expect(
                existsSync(resolve(dirname(file), specifier.text)),
                `${file}: ${specifier.text}`,
              ).toBe(true);
            }
            ts.forEachChild(node, check);
          };
          check(source);
        }
      }
    };
    visit(dist);
  });

  it('executes packed SHA-256 dependencies without producer paths (#4008)', () => {
    if (!consumer) throw new Error('Packed consumer was not created');
    const hashModule = pathToFileURL(
      join(
        consumer.directory,
        'node_modules/@happyvertical/smrt-core/dist/utils/sha256.js',
      ),
    ).href;
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      const { sha256Hex, sha256Base64Url } = await import(${JSON.stringify(hashModule)});
      for (const text of ['', 'abc', 'éducation 🎓']) {
        assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'));
        assert.equal(sha256Base64Url(text), createHash('sha256').update(text).digest('base64url'));
      }
    `,
      ],
      consumer.directory,
    );
  });

  it('anchors an import-only Commerce serializer to its installed Invoice module, not cwd', () => {
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    expect(result.error, stderr).toBeUndefined();
    expect(result.status, stderr).toBe(0);
    const consumerDirectory = consumer?.directory;
    if (!consumerDirectory) throw new Error('Packed consumer was not created');
    const report = JSON.parse(stdout.trim()) as ConsumerReport;
    expect(report.result).toEqual({
      source: 'commerce',
      title: 'legacy invoice',
      permissions: ['invoices.read'],
    });
    expect(report.sourceFilePath).toContain('/node_modules/.pnpm/');
    expect(report.sourceFilePath).toContain('/dist/index.js');
    expect(report.missingExport).toBe(
      "MCP get serializer 'missingSerializer' was not exported by '@happyvertical/smrt-commerce'",
    );
    expect(report.coreEntry).toContain(
      `${consumerDirectory}/node_modules/.pnpm/`,
    );
    expect(report.commerceEntry).toContain(
      `${consumerDirectory}/node_modules/.pnpm/`,
    );
    expect(
      existsSync(
        join(
          consumerDirectory,
          'node_modules/@happyvertical/smrt-core/node_modules/@happyvertical/smrt-commerce',
        ),
      ),
    ).toBe(false);
  });
});
