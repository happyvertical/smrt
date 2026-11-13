import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'svelte/compiler';
import ts from 'typescript';

test('recipe screens never reach AppShell, including through type imports', () => {
  const root = resolve('src/components');
  const pending = [[resolve(root, 'screens/index.ts'), []]];
  const seen = new Set();
  while (pending.length) {
    const [file, chain] = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const path = [...chain, file];
    assert.notEqual(
      file,
      resolve(root, 'app/AppShell.svelte'),
      `Recipe screen dependency reached the app shell:\n${path.join('\n -> ')}`,
    );
    let source = readFileSync(file, 'utf8');
    if (file.endsWith('.svelte')) {
      const ast = parse(source);
      source = [ast.instance, ast.module]
        .filter(Boolean)
        .map((script) => source.slice(script.content.start, script.content.end))
        .join('\n');
    }
    // Include type-only imports: svelte-check follows these even though the
    // client bundler erases them. Restrict traversal to this package's source.
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!fileName.startsWith('.')) continue;
      const target = resolve(dirname(file), fileName);
      const dependency = [target.replace(/\.js$/, '.ts'), target].find(existsSync);
      assert.ok(dependency, `Unresolved local dependency: ${file} -> ${fileName}`);
      pending.push([dependency, path]);
    }
  }
  assert.ok(seen.has(resolve(root, 'screens/RecordScreen.svelte')));
  assert.ok(seen.has(resolve(root, 'cookbook/context.ts')));
  assert.ok(seen.has(resolve(root, 'cookbook/types.ts')));
});
