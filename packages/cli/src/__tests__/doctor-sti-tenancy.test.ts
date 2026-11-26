/**
 * `smrt doctor` lists the STI families whose members' tenancy differs from
 * the table owner's (#5375, row 36).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findMixedTenancyFamilies,
  runStiTenancyDoctorSection,
} from '../commands/doctor-sti-tenancy.js';

const manifest = {
  objects: {
    '@app/notes:Note': {
      className: 'Note',
      qualifiedName: '@app/notes:Note',
      decoratorConfig: { tableStrategy: 'sti' },
    },
    '@app/notes:OwnedNote': {
      className: 'OwnedNote',
      qualifiedName: '@app/notes:OwnedNote',
      extends: 'Note',
      decoratorConfig: { tenantScoped: { mode: 'optional' } },
    },
    '@app/notes:PlainNote': {
      className: 'PlainNote',
      qualifiedName: '@app/notes:PlainNote',
      extends: 'Note',
      decoratorConfig: {},
    },
    '@app/memos:Memo': {
      className: 'Memo',
      qualifiedName: '@app/memos:Memo',
      decoratorConfig: {
        tableStrategy: 'sti',
        tenantScoped: { mode: 'optional' },
      },
    },
    '@app/memos:InheritedMemo': {
      className: 'InheritedMemo',
      qualifiedName: '@app/memos:InheritedMemo',
      extends: 'Memo',
      decoratorConfig: {},
    },
    '@app/memos:StrictMemo': {
      className: 'StrictMemo',
      qualifiedName: '@app/memos:StrictMemo',
      extends: 'Memo',
      decoratorConfig: { tenantScoped: { mode: 'required' } },
    },
  },
};

describe('smrt doctor: STI family tenancy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a mixed family warns once and doctor lists it', () => {
    expect(findMixedTenancyFamilies(manifest)).toEqual([
      { family: '@app/memos:Memo', excluded: ['@app/memos:StrictMemo'] },
      { family: '@app/notes:Note', excluded: ['@app/notes:OwnedNote'] },
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'smrt-doctor-sti-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.smrt'));
    writeFileSync(
      join(dir, '.smrt', 'manifest.json'),
      JSON.stringify(manifest),
    );
    const section = runStiTenancyDoctorSection(dir);
    expect(section.applies).toBe(true);
    expect(section.warnings).toHaveLength(2);
    expect(section.warnings[0]).toContain('@app/memos:StrictMemo');
    expect(section.warnings[1]).toContain('@app/notes:OwnedNote');
  });

  it('a family whose members share the owner tenancy passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smrt-doctor-sti-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.smrt'));
    const { objects } = manifest;
    writeFileSync(
      join(dir, '.smrt', 'manifest.json'),
      JSON.stringify({
        objects: {
          '@app/memos:Memo': objects['@app/memos:Memo'],
          '@app/memos:InheritedMemo': objects['@app/memos:InheritedMemo'],
        },
      }),
    );
    const section = runStiTenancyDoctorSection(dir);
    expect(section.warnings).toEqual([]);
    expect(section.passed).toEqual(['STI family tenancy']);
  });
});
