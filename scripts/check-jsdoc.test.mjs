import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'check-jsdoc.mjs');

/** A throwaway repository holding one package with one exported component. */
function fixture({ strict, documented, directExport = false, mode, bareDefault = false, moduleScript = false, moduleProps = false, nestedExports = false, defaultWithNamed = false, defaultExport = false, propsShape = 'interface', decoyProps = false, stringExports = false, namedDefaultImport = false }) {
  const root = mkdtempSync(join(tmpdir(), 'jsdoc-gate-'));
  const pkg = join(root, 'packages', 'demo');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });

  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@happyvertical/smrt-demo',
      version: '0.0.0',
      ...(mode !== undefined ? { smrtJsdoc: mode } : strict ? { smrtJsdoc: 'strict' } : {}),
      exports: nestedExports
        ? { './svelte': { import: { types: './dist/svelte/index.d.ts', default: './dist/svelte/index.js' } } }
        : stringExports
        ? './dist/svelte/index.js'
        : {
            './svelte': { svelte: './dist/svelte/index.js' },
            ...(directExport
              ? { './direct': { svelte: './dist/svelte/Direct.svelte.js' } }
              : {})
          }
    })
  );
  mkdirSync(join(pkg, 'src', 'svelte'), { recursive: true });
  writeFileSync(
    join(pkg, 'src', 'svelte', 'index.ts'),
    bareDefault
      ? "export { default } from './Widget.svelte';\n"
      : namedDefaultImport
        ? "import { default as Widget } from './Widget.svelte';\nexport { Widget };\n"
        : "import Widget from './Widget.svelte';\nexport { Widget };\n"
  );
  if (directExport) {
    writeFileSync(
      join(pkg, 'src', 'svelte', 'Direct.svelte'),
      '<script lang="ts">\nexport interface Props {\n\ttoken?: string;\n}\nlet { token }: Props = $props();\n</script>\n<span>{token}</span>\n'
    );
  }
  writeFileSync(
    join(pkg, 'src', 'svelte', 'Widget.svelte'),
    `${moduleScript ? '<script module lang="ts">\nexport const NAME = "widget";\n</' + 'script>\n' : ''}${moduleProps ? '<script module lang="ts">\nexport interface HelperProps {\n\t/** Documented module helper. */\n\thelper?: string;\n}\n</' + 'script>\n' : ''}<script lang="ts">
${decoyProps ? 'export interface DecoyProps {\n\t/** Unrelated. */\n\tother?: string;\n}\n' : ''}${
      propsShape === 'type' ? 'export type Props = {' : 'export interface Props {'
    }
${documented ? '\t/** Identifier of the record on display. */\n' : ''}\trecordId?: string;
}${propsShape === 'type' ? ';' : ''}
let { recordId }: Props = $props();
</script>
<span>{recordId}</span>
`
  );
  return root;
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--root', root], {
      encoding: 'utf8'
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('a strict package fails when an exported prop carries no JSDoc', () => {
  const root = fixture({ strict: true, documented: false });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a strict package passes once the prop is documented', () => {
  const root = fixture({ strict: true, documented: true });
  try {
    assert.equal(run(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package that has not opted in reports without failing', () => {
  const root = fixture({ strict: false, documented: false });
  try {
    const result = run(root);
    assert.equal(result.code, 0);
    assert.match(result.output, /\[report\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a component exported straight from the exports map is still gated', () => {
  const root = fixture({ strict: true, documented: true, directExport: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare default re-export is still gated', () => {
  const root = fixture({ strict: true, documented: false, bareDefault: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unrecognized smrtJsdoc mode fails rather than silently reporting', () => {
  const root = fixture({ strict: false, documented: false, mode: 'strcit' });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /unrecognized "smrtJsdoc"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a module script ahead of the instance script does not bypass the gate', () => {
  const root = fixture({ strict: true, documented: false, moduleScript: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('props declared as a type alias are gated like an interface', () => {
  const root = fixture({ strict: true, documented: false, propsShape: 'type' });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unrelated *Props declaration does not shadow the real one', () => {
  const root = fixture({ strict: true, documented: false, decoyProps: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a string-form exports field is still scanned', () => {
  const root = fixture({ strict: true, documented: false, stringExports: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a named-default import backing an export is still gated', () => {
  const root = fixture({ strict: true, documented: false, namedDefaultImport: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a documented Props in a module script does not mask the instance script', () => {
  const root = fixture({ strict: true, documented: false, moduleProps: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a nested conditional exports map is still traversed', () => {
  const root = fixture({ strict: true, documented: false, nestedExports: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a default import alongside named specifiers is still gated', () => {
  const root = fixture({ strict: true, documented: false, defaultWithNamed: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a default-exported component barrel is still gated', () => {
  const root = fixture({ strict: true, documented: false, defaultExport: true });
  try {
    const result = run(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /recordId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
