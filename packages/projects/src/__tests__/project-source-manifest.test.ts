import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('project source runtime contract', () => {
  it('registers governance fields without a Vite or Vitest transform', () => {
    const env = { ...process.env };
    delete env.VITEST;
    delete env.__SMRT_VITEST_SETUP_OPTIONS__;
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { ObjectRegistry } from './packages/core/dist/index.js';
      await import('./packages/projects/src/index.ts');
      for (const [name, required] of Object.entries({
        ProjectQuestion: ['prompt', 'ownerId', 'revision'],
        ProjectDecision: ['decisionOptions', 'outcome', 'rationale'],
        ProjectGovernanceEvent: ['actorId', 'fromOwnerId', 'toOwnerId'],
        ProjectSpecification: ['cookbook', 'revision'],
      })) {
        const fields = ObjectRegistry.getFields('@happyvertical/smrt-projects:' + name);
        for (const field of required) if (!fields.has(field)) throw new Error(name + ' missing ' + field);
      }
      console.log('source runtime fields registered');
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        env,
        encoding: 'utf8',
      },
    );
    expect(output).toContain('source runtime fields registered');
  });

  it('ships portable source schema with nullable participant integration', () => {
    const text = readFileSync(
      new URL('../manifest/manifest.json', import.meta.url),
      'utf8',
    );
    const manifest = JSON.parse(text);
    const request =
      manifest.objects['@happyvertical/smrt-projects:DevelopmentRequest'];
    expect(request.fields.integrationId.required).toBe(false);
    expect(request.schema.columns.integration_id).toMatchObject({
      type: 'UUID',
      notNull: false,
    });
    expect(text).not.toContain('/Users/');
    for (const name of [
      'ProjectQuestion',
      'ProjectDecision',
      'ProjectGovernanceEvent',
      'ProjectSpecification',
    ]) {
      expect(
        manifest.objects['@happyvertical/smrt-projects:' + name].schema
          .tableName,
      ).toBeTruthy();
    }
  });
});
