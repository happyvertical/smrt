import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewSmrtProject } from './review-smrt-project.js';

describe('reviewSmrtProject', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `smrt-review-project-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports downstream ecosystem alignment findings', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify(
        {
          name: '@test/downstream',
          version: '1.0.0',
          dependencies: {
            vite: '^7.0.0',
          },
        },
        null,
        2,
      ),
    );
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(
      join(tmpDir, 'src', 'model.ts'),
      `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Profile } from '@happyvertical/smrt-profiles';

@smrt()
export class Project extends SmrtObject {
  ownerProfileId: string = '';
  name = Profile.name;
}
      `.trim(),
    );
    await writeFile(
      join(tmpDir, 'src', 'manifest-writer.ts'),
      `
import { writeFile } from 'node:fs/promises';

export async function writeManifest() {
  await writeFile('.smrt/manifest.json', JSON.stringify({ objects: {} }));
}
      `.trim(),
    );
    await writeFile(
      join(tmpDir, 'src', 'server.ts'),
      `
import { createServer } from 'node:http';
createServer((_req, res) => res.end('ok'));
      `.trim(),
    );
    await writeFile(
      join(tmpDir, 'src', 'auth.ts'),
      `
export const sessions = [{ tenantId: 'tenant-1', role: 'admin' }];
      `.trim(),
    );
    await writeFile(
      join(tmpDir, 'src', 'App.svelte'),
      `<script lang="ts">export let name = 'demo';</script><h1>{name}</h1>`,
    );

    const result = await reviewSmrtProject({ directory: tmpDir });
    const parsed = JSON.parse(result);
    const codes = parsed.findings.map((finding: any) => finding.code);

    expect(parsed.packageCount).toBe(1);
    expect(codes).toContain('missing-happyvertical-dependencies');
    expect(codes).toContain('custom-object-manifest-generation');
    expect(codes).toContain('direct-storage-bypass');
    expect(codes).toContain('custom-http-shell');
    expect(codes).toContain('local-auth-tenancy');
    expect(codes).toContain('missing-smrt-svelte-shell');
    expect(parsed.summary.high).toBeGreaterThanOrEqual(1);
    expect(parsed.suggestedFollowUpIssues.length).toBe(parsed.findings.length);
  });

  it('can omit source evidence for compact output', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: '@test/compact', dependencies: {} }),
    );
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(
      join(tmpDir, 'src', 'model.ts'),
      `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt()
export class Compact extends SmrtObject {}
      `.trim(),
    );

    const result = await reviewSmrtProject({
      directory: tmpDir,
      includeSourceEvidence: false,
    });
    const parsed = JSON.parse(result);

    expect(parsed.findings[0]).not.toHaveProperty('evidence');
  });

  it('reports package-level router dependencies once per package', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: '@test/router-app',
        dependencies: { express: '^5.0.0' },
      }),
    );
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(join(tmpDir, 'src', 'b.ts'), 'export const b = 2;');

    const result = await reviewSmrtProject({ directory: tmpDir });
    const parsed = JSON.parse(result);
    const httpShellFindings = parsed.findings.filter(
      (finding: any) => finding.code === 'custom-http-shell',
    );

    expect(httpShellFindings).toHaveLength(1);
    expect(httpShellFindings[0].evidence).toEqual([
      expect.objectContaining({
        filePath: 'package.json',
        detail: 'Declares custom router package(s): express.',
      }),
    ]);
  });
});
