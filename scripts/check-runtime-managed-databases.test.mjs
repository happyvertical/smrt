import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, findUses, scanPackages } from './check-runtime-managed-databases.mjs';

const script = fileURLToPath(new URL('./check-runtime-managed-databases.mjs', import.meta.url));
const ENGINE = 'packages/app-shell/src/engine/app-runtime.ts';
const ENGINE_POSTGRES = 'packages/app-shell/src/engine/db/postgres.ts';
const CALL = `import { declareRuntimeManagedDatabase } from '@happyvertical/smrt-core';
declareRuntimeManagedDatabase(db, { owner: 'x', reason: 'y' });
`;

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-managed-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const run = (root) =>
  spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });

test('ignores the name in comments and strings', () => {
  assert.deepEqual(
    findUses(`// declareRuntimeManagedDatabase(db)
/* declareRuntimeManagedDatabase */
const s = 'declareRuntimeManagedDatabase(db)';
declareRuntimeManagedDatabase(db, d);`),
    [4],
  );
});

test('the allowed engine call passes; tests and core exports are not flagged', () => {
  const root = repo({
    [ENGINE]: CALL,
    [ENGINE_POSTGRES]: CALL,
    'packages/core/src/migrations/index.ts': 'export { declareRuntimeManagedDatabase } from "./x.js";\n',
    'packages/core/src/migrations/runtime-managed-database.ts':
      'export function declareRuntimeManagedDatabase() {}\n',
    'packages/p/src/store.test.ts': CALL,
    'packages/p/src/__tests__/store.ts': CALL,
  });
  try {
    const out = run(root);
    assert.equal(out.status, 0, out.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new caller fails with file and line, also through an alias', () => {
  const root = repo({
    [ENGINE]: CALL,
    'packages/p/src/db.ts': CALL,
    'packages/q/src/db.ts':
      "import { declareRuntimeManagedDatabase as skip } from '@happyvertical/smrt-core';\nskip(db, d);\n",
  });
  try {
    const out = run(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /packages\/p\/src\/db\.ts:1 uses declareRuntimeManagedDatabase/);
    assert.match(out.stderr, /packages\/p\/src\/db\.ts:2 uses/);
    assert.match(out.stderr, /packages\/q\/src\/db\.ts:1 uses/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an allowed file that no longer calls it is a stale entry', () => {
  assert.deepEqual(evaluate(new Map(), { [ENGINE]: 'r' }, new Set()), [
    `${ENGINE} is allowed to use declareRuntimeManagedDatabase but no longer does; remove it from ALLOWED_CALLERS.`,
  ]);
});

test('the repository passes', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(evaluate(scanPackages(root)), []);
});
