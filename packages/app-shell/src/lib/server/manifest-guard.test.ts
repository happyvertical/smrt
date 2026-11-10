import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertShellManifest,
  missingShellModels,
  SHELL_MODELS,
} from '../../../tools/manifest-guard.ts';

const root = join(import.meta.dirname, '..', '..', '..');

describe('the shell models reach the smrt manifest', () => {
  it('vite.config.ts scans the directory that holds the models', () => {
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    const dir = /objectsDir:\s*'([^']+)'/.exec(config)?.[1];
    expect(dir).toBe('src/lib/objects');
    for (const name of SHELL_MODELS) {
      expect(() =>
        readFileSync(join(root, dir as string, `${name}.ts`), 'utf8'),
      ).not.toThrow();
    }
  });

  it('reports models the manifest lacks', () => {
    const objects = Object.fromEntries(
      ['App', 'AppVersion'].map((n) => [`@x:${n}`, { className: n }]),
    );
    expect(missingShellModels({ objects })).toEqual([
      'Approval',
      'AssistantThread',
      'AssistantMessage',
    ]);
    expect(missingShellModels({})).toEqual([...SHELL_MODELS]);
  });

  it('the assertion fails on a manifest of other packages only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    mkdirSync(join(dir, '.smrt'));
    writeFileSync(
      join(dir, '.smrt', 'manifest.json'),
      JSON.stringify({
        objects: { '@pkg:ApiKey': { className: 'ApiKey' } },
      }),
    );
    expect(() => assertShellManifest(dir)).toThrow(/objectsDir/);
  });
});
