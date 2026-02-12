/**
 * Test: TS AST scanner resolves import aliases in extends clauses.
 *
 * When a class uses `import { Performer as PerformerBase }`, the scanner
 * should resolve the alias so `extends` contains "Performer" not "PerformerBase".
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASTScanner } from '../scanner/ast-scanner.js';

const tmpDir = join(__dirname, '__tmp_alias_test__');

beforeAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  writeFileSync(
    join(tmpDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        experimentalDecorators: true,
        strict: false,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }),
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Import Alias Resolution in TS AST Scanner', () => {
  it('should resolve aliased import in extends clause', () => {
    const filePath = join(tmpDir, 'test-alias.ts');
    writeFileSync(
      filePath,
      `
import { Performer as PerformerBase } from '@happyvertical/smrt-video';

function smrt(config?: any) {
  return function (target: any) { return target; };
}
class SmrtObject {}
class PerformerBase extends SmrtObject {}

@smrt({ tableStrategy: 'sti' })
export class Performer extends PerformerBase {}
`,
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);

    const scanner = new ASTScanner([filePath], {
      baseClasses: ['SmrtObject', 'PerformerBase'],
    });
    const results = scanner.scanFiles();

    process.chdir(origCwd);

    const performer = results
      .flatMap((r) => r.objects)
      .find((o) => o.className === 'Performer');

    expect(performer).toBeDefined();
    expect(performer?.extends).toBe('Performer'); // Resolved from PerformerBase
  });

  it('should not alter non-aliased imports', () => {
    const filePath = join(tmpDir, 'test-no-alias.ts');
    writeFileSync(
      filePath,
      `
function smrt(config?: any) {
  return function (target: any) { return target; };
}
class SmrtObject {}

@smrt()
export class Product extends SmrtObject {
  name: string = '';
}
`,
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);

    const scanner = new ASTScanner([filePath], {
      baseClasses: ['SmrtObject'],
    });
    const results = scanner.scanFiles();

    process.chdir(origCwd);

    const product = results
      .flatMap((r) => r.objects)
      .find((o) => o.className === 'Product');

    expect(product).toBeDefined();
    expect(product?.extends).toBe('SmrtObject'); // Unchanged
  });

  it('should handle multiple aliases in one file', () => {
    const filePath = join(tmpDir, 'test-multi.ts');
    writeFileSync(
      filePath,
      `
import { Character as CharacterBase } from '@happyvertical/smrt-video';
import { Scene as SceneBase } from '@happyvertical/smrt-video';

function smrt(config?: any) {
  return function (target: any) { return target; };
}
class SmrtObject {}
class CharacterBase extends SmrtObject {}
class SceneBase extends SmrtObject {}

@smrt()
export class Character extends CharacterBase {}

@smrt()
export class Scene extends SceneBase {}

@smrt()
export class Plain extends SmrtObject {}
`,
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);

    const scanner = new ASTScanner([filePath], {
      baseClasses: ['SmrtObject', 'CharacterBase', 'SceneBase'],
    });
    const results = scanner.scanFiles();

    process.chdir(origCwd);

    const objects = results.flatMap((r) => r.objects);
    const character = objects.find((o) => o.className === 'Character');
    const scene = objects.find((o) => o.className === 'Scene');
    const plain = objects.find((o) => o.className === 'Plain');

    expect(character?.extends).toBe('Character'); // Resolved
    expect(scene?.extends).toBe('Scene'); // Resolved
    expect(plain?.extends).toBe('SmrtObject'); // Unchanged
  });
});
