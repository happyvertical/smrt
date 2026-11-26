import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// A module-is-the-entry-point check must compare URLs built by
// `pathToFileURL`: a hand-assembled `file://` string never matches on Windows
// (drive letter, backslashes) or for a path that needs URL encoding (#4856).
const HAND_BUILT_ENTRY_CHECKS = [
  /file:\/\/\$\{\s*process\.argv\[1\]\s*\}/,
  /new URL\(\s*import\.meta\.url\s*\)\.pathname\s*===/,
  /===\s*new URL\(\s*import\.meta\.url\s*\)\.pathname/,
];

function trackedSourceFiles() {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.js', '*.mjs', '*.cjs', '*.ts', '*.mts'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
}

test('no tracked module decides it is the entry point from a hand-built file URL', () => {
  const offenders = [];
  for (const file of trackedSourceFiles()) {
    if (file === 'scripts/entry-point-check.test.mjs') continue;
    let source;
    try {
      source = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    if (HAND_BUILT_ENTRY_CHECKS.some((pattern) => pattern.test(source))) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the pathToFileURL entry check recognises a script whose path needs URL encoding', () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'smrt-entry-check-'),
  );
  try {
    const directory = join(root, 'dir with space #1');
    mkdirSync(directory, { recursive: true });
    const script = join(directory, 'entry.mjs');
    writeFileSync(
      script,
      [
        "import { pathToFileURL } from 'node:url';",
        'const viaUrl =',
        '  Boolean(process.argv[1]) &&',
        '  import.meta.url === pathToFileURL(process.argv[1]).href;',
        'const handBuilt = import.meta.url === `file://${process.argv[1]}`;',
        'console.log(JSON.stringify({ viaUrl, handBuilt }));',
      ].join('\n'),
    );
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), { viaUrl: true, handBuilt: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
