import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function inspectGraph(
  entries: string[],
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
  resolveImport: (
    file: string,
    specifier: string,
  ) => string | undefined = resolveWorkspaceImport,
) {
  const seen = new Set<string>();
  const forbidden: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === 'require')
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument))
          imports.push(argument.text);
        // Core's workspace/plugin loaders have runtime-selected dependencies.
        // Engine modules themselves must keep every dependency statically auditable.
        else if (file.startsWith(`${src}/engine/`))
          forbidden.push(`${relative(src, file)}: non-static import`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (let specifier of imports) {
      const self = '@happyvertical/smrt-app-shell';
      if (
        specifier === `${self}/engine` ||
        specifier === `${self}/engine/worker`
      )
        specifier = `./${specifier.endsWith('/worker') ? 'app-worker' : 'index'}.ts`;
      else if (specifier === self || specifier.startsWith(`${self}/`)) {
        forbidden.push(`${relative(src, file)} -> ${specifier}`);
        continue;
      }
      if (
        /^(svelte(?:\/|$)|@sveltejs\/|\$lib(?:\/|$)|\$app(?:\/|$)|@happyvertical\/smrt-svelte(?:\/|$)|@happyvertical\/[^/]+\/svelte(?:\/|$))/.test(
          specifier,
        ) ||
        /\.svelte(?:\?|$)/.test(specifier)
      ) {
        forbidden.push(`${relative(src, file)} -> ${specifier}`);
        continue;
      }
      const resolved = resolveImport(file, specifier);
      if (resolved) {
        if (
          resolved.startsWith(`${src}/`) &&
          relative(resolve(src, 'engine'), resolved).startsWith('..')
        )
          forbidden.push(
            `${relative(src, file)} -> ${relative(src, resolved)}`,
          );
        else queue.push(resolved);
      } else if (specifier.startsWith('.'))
        forbidden.push(`${relative(src, file)}: unresolved ${specifier}`);
    }
  }
  return { seen, forbidden };
}

const packages = resolve(src, '../../..');
function resolveWorkspaceImport(
  file: string,
  specifier: string,
): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    file,
    {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      resolveJsonModule: true,
    },
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return undefined;
  // Follow workspace sources rather than terminating at package-name imports or
  // declaration stubs. External dependencies remain outside this repo guard.
  if (
    !resolved.startsWith(`${packages}/`) ||
    resolved.includes('/node_modules/')
  )
    return undefined;
  const source = resolved
    .replace('/dist/', '/src/')
    .replace(/\.d\.ts$|\.js$/, '.ts');
  return [source, resolved].find(existsSync);
}

it('keeps both engine entry graphs independent of shell UI and SvelteKit', () => {
  const entries = [
    resolve(src, 'engine/index.ts'),
    resolve(src, 'engine/app-worker.ts'),
  ];
  for (const entry of readdirSync(resolve(src, 'engine'), {
    recursive: true,
    withFileTypes: true,
  }))
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    )
      entries.push(resolve(entry.parentPath, entry.name));
  const { seen, forbidden } = inspectGraph(entries);
  expect(seen.size).toBeGreaterThan(10);
  expect(forbidden).toEqual([]);
});

it.each([
  '@happyvertical/smrt-reports/svelte',
  '@happyvertical/smrt-svelte',
  '@happyvertical/smrt-svelte/widgets',
  '@happyvertical/another-package/svelte',
])('rejects Svelte reached directly or transitively through %s', (specifier) => {
  const files: Record<string, string> = {
    '/entry.ts': `import '${specifier}';`,
    '/transitive.ts': "export * from '@happyvertical/fixture';",
    '/workspace.ts': `export * from '${specifier}';`,
  };
  const read = (file: string) => files[file];
  const resolver = (_file: string, name: string) =>
    name === '@happyvertical/fixture' ? '/workspace.ts' : undefined;
  expect(inspectGraph(['/entry.ts'], read, resolver).forbidden).toHaveLength(1);
  expect(
    inspectGraph(['/transitive.ts'], read, resolver).forbidden,
  ).toHaveLength(1);
});
