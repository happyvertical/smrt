import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('keeps both engine entry graphs independent of shell UI and SvelteKit', () => {
  const seen = new Set<string>();
  const forbidden: string[] = [];
  const queue = [
    resolve(src, 'engine/index.ts'),
    resolve(src, 'engine/app-worker.ts'),
  ];
  // Also cover dormant production modules before a future entry exposes them.
  for (const entry of readdirSync(resolve(src, 'engine'), {
    recursive: true,
    withFileTypes: true,
  }))
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    )
      queue.push(resolve(entry.parentPath, entry.name));
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
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
        else forbidden.push(`${relative(src, file)}: non-static import`);
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
        /^(svelte(?:\/|$)|@sveltejs\/|\$lib(?:\/|$)|\$app(?:\/|$))/.test(
          specifier,
        ) ||
        /\.svelte(?:\?|$)/.test(specifier)
      ) {
        forbidden.push(`${relative(src, file)} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      const resolved = [
        target,
        `${target}.ts`,
        resolve(target, 'index.ts'),
      ].find(existsSync);
      if (
        !resolved ||
        !relative(resolve(src, 'engine'), resolved).startsWith('..')
      ) {
        if (resolved) queue.push(resolved);
        else forbidden.push(`${relative(src, file)}: unresolved ${specifier}`);
      } else
        forbidden.push(`${relative(src, file)} -> ${relative(src, resolved)}`);
    }
  }
  expect(seen.size).toBeGreaterThan(10);
  expect(forbidden).toEqual([]);
});
