/**
 * refreshAgentDocs / safeRefreshAgentDocs / inspectAgentDocs and the doctor
 * "Agent knowledge" section (#4878 item C), against temp consumer projects.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectAgentDocs,
  refreshAgentDocs,
  safeRefreshAgentDocs,
} from '../docs-refresh.js';
import { runAgentKnowledgeDoctorSection } from '../doctor-agent-knowledge.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-docs-refresh-')));
  writeFileSync(join(root, 'package.json'), '{"name":"app"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function install(version: string): void {
  const dir = join(root, 'node_modules', '@happyvertical', 'smrt-core');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@happyvertical/smrt-core', version }),
  );
  writeFileSync(join(dir, 'AGENTS.md'), '# smrt-core\n\nDocs.');
  writeFileSync(
    join(dir, 'dist', 'smrt-knowledge.okf.md'),
    `---\ntype: "Component"\npackage_version: "${version}"\n---\n\n# core\n`,
  );
}

const sinks = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
  };
};
const bundlePath = () => join(root, '.agents', 'smrt-knowledge', 'bundle.json');

describe('refreshAgentDocs', () => {
  it('write mode writes everything and reports through the log seam', async () => {
    install('1.0.0');
    const s = sinks();
    const result = await refreshAgentDocs({ cwd: root, log: s.log });
    expect(result.status).toBe('written');
    expect(result.root).toBe(root);
    expect(existsSync(bundlePath())).toBe(true);
    expect(existsSync(join(root, '.agents/smrt-framework.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/smrt-catalog/SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.agents/skills/smrt-catalog/SKILL.md'))).toBe(
      true,
    );
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain(
      'smrt:agents:begin',
    );
    expect(s.out.join('\n')).toContain('Generated .agents/smrt-framework.md');
  });

  it('write mode writes again even when fresh; if-stale does not', async () => {
    install('1.0.0');
    expect(
      (await refreshAgentDocs({ cwd: root, log: sinks().log })).status,
    ).toBe('written');
    expect(
      (
        await refreshAgentDocs({
          cwd: root,
          mode: 'if-stale',
          log: sinks().log,
        })
      ).status,
    ).toBe('skipped-fresh');
    expect(
      (await refreshAgentDocs({ cwd: root, log: sinks().log })).status,
    ).toBe('written');
  });

  it('if-stale writes for a missing bundle and for version drift', async () => {
    install('1.0.0');
    const first = await refreshAgentDocs({
      cwd: root,
      mode: 'if-stale',
      log: sinks().log,
    });
    expect(first.status).toBe('written');
    install('1.0.1');
    const second = await refreshAgentDocs({
      cwd: root,
      mode: 'if-stale',
      log: sinks().log,
    });
    expect(second.status).toBe('written');
    expect(
      JSON.parse(readFileSync(bundlePath(), 'utf8')).packages[0].version,
    ).toBe('1.0.1');
  });

  it('reports nothing-installed as a result, never an exit', async () => {
    for (const mode of ['write', 'if-stale'] as const) {
      const result = await refreshAgentDocs({
        cwd: root,
        mode,
        log: sinks().log,
      });
      expect(result.status).toBe('skipped-nothing-installed');
    }
  });

  it('dry-run writes nothing', async () => {
    install('1.0.0');
    const s = sinks();
    const result = await refreshAgentDocs({
      cwd: root,
      dryRun: true,
      log: s.log,
    });
    expect(result.status).toBe('written');
    expect(result.dryRun).toBe(true);
    expect(existsSync(join(root, '.agents'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(s.out.join('\n')).toContain('# SMRT Framework Context');
  });

  it('skills:false and agentsBlock:false opt out', async () => {
    install('1.0.0');
    await refreshAgentDocs({
      cwd: root,
      skills: false,
      agentsBlock: false,
      log: sinks().log,
    });
    expect(existsSync(join(root, '.claude/skills'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(bundlePath())).toBe(true);
  });
});

describe('safeRefreshAgentDocs', () => {
  it('never throws and returns a failed result with a warning', async () => {
    install('1.0.0');
    // A file where the output directory must go makes the write throw.
    writeFileSync(join(root, '.agents'), 'not a directory');
    const s = sinks();
    const result = await safeRefreshAgentDocs({ cwd: root, log: s.log });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('error');
    expect(result.warnings[0]).toContain('agent docs refresh failed');
    expect(s.err).toHaveLength(1);
  });

  it('is quiet on success', async () => {
    install('1.0.0');
    const s = sinks();
    expect((await safeRefreshAgentDocs({ cwd: root, log: s.log })).status).toBe(
      'written',
    );
    expect(s.out).toEqual([]);
    expect(s.err).toEqual([]);
  });
});

describe('inspectAgentDocs and the doctor section', () => {
  it('skips quietly where no smrt package is installed', () => {
    const state = inspectAgentDocs(root);
    expect(state.installed).toBe(false);
    expect(runAgentKnowledgeDoctorSection(root)).toEqual({
      applies: false,
      lines: [],
      warnings: [],
      passed: [],
    });
  });

  it('is read-only and reports missing everything separately', () => {
    install('1.0.0');
    const state = inspectAgentDocs(root);
    expect(state).toMatchObject({
      installed: true,
      bundle: 'missing',
      block: 'missing',
    });
    expect(state.skills.map((skill) => [skill.dir, skill.present])).toEqual([
      ['.claude/skills', false],
      ['.agents/skills', false],
    ]);
    expect(existsSync(join(root, '.agents'))).toBe(false);

    const section = runAgentKnowledgeDoctorSection(root);
    expect(section.passed).toEqual([]);
    expect(section.warnings).toHaveLength(4);
    expect(section.warnings.every((w) => w.includes('smrt docs:agents'))).toBe(
      true,
    );
    expect(section.warnings[0]).toContain('bundle is missing');
    expect(section.warnings[1]).toContain('AGENTS.md');
    expect(section.warnings[2]).toContain('.claude/skills');
    expect(section.warnings[3]).toContain('.agents/skills');
  });

  it('passes after a refresh', async () => {
    install('1.0.0');
    await refreshAgentDocs({ cwd: root, log: sinks().log });
    const section = runAgentKnowledgeDoctorSection(root);
    expect(section.warnings).toEqual([]);
    expect(section.passed).toEqual(['Agent knowledge']);
  });

  it('reports a stale bundle', async () => {
    install('1.0.0');
    await refreshAgentDocs({ cwd: root, log: sinks().log });
    install('1.0.1');
    const section = runAgentKnowledgeDoctorSection(root);
    expect(section.warnings).toHaveLength(1);
    expect(section.warnings[0]).toContain('stale');
    expect(section.warnings[0]).toContain('smrt docs:agents');
  });

  it('judges only the .agents bundle: a stale legacy .claude bundle is ignored', async () => {
    install('1.0.0');
    await refreshAgentDocs({ cwd: root, log: sinks().log });
    const legacy = join(root, '.claude', 'smrt-knowledge');
    cpSync(join(root, '.agents', 'smrt-knowledge'), legacy, {
      recursive: true,
    });
    writeFileSync(
      join(legacy, 'components', 'smrt-core.md'),
      '---\ntype: "Component"\npackage_version: "0.0.1"\n---\n\n# old\n',
    );
    expect(inspectAgentDocs(root).bundle).toBe('fresh');
    const second = await refreshAgentDocs({
      cwd: root,
      mode: 'if-stale',
      log: sinks().log,
    });
    expect(second.status).toBe('skipped-fresh');
  });

  it('reports missing when only a legacy .claude bundle exists', async () => {
    install('1.0.0');
    await refreshAgentDocs({ cwd: root, log: sinks().log });
    renameSync(join(root, '.agents', 'smrt-knowledge'), join(root, 'legacy-x'));
    mkdirSync(join(root, '.claude'), { recursive: true });
    renameSync(join(root, 'legacy-x'), join(root, '.claude', 'smrt-knowledge'));
    expect(inspectAgentDocs(root).bundle).toBe('missing');
  });

  it('reports a missing block, a refused block and a missing skill each on their own', async () => {
    install('1.0.0');
    await refreshAgentDocs({ cwd: root, log: sinks().log });

    writeFileSync(join(root, 'AGENTS.md'), '# App\n\nno block\n');
    let warnings = runAgentKnowledgeDoctorSection(root).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no smrt block');

    writeFileSync(
      join(root, 'AGENTS.md'),
      '# App\n<!-- smrt:agents:begin -->\n',
    );
    warnings = runAgentKnowledgeDoctorSection(root).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cannot be refreshed');

    await refreshAgentDocs({ cwd: root, agentsBlock: false, log: sinks().log });
    writeFileSync(join(root, 'AGENTS.md'), '# App\n');
    rmSync(join(root, '.agents/skills'), { recursive: true });
    warnings = runAgentKnowledgeDoctorSection(root).warnings;
    expect(
      warnings.filter((w) => w.includes('skill smrt-catalog')),
    ).toHaveLength(1);
    expect(warnings.find((w) => w.includes('skill'))).toContain(
      '.agents/skills',
    );
  });

  it('resolves the pnpm workspace root from a member', async () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    const member = join(root, 'apps', 'web');
    mkdirSync(
      join(member, 'node_modules', '@happyvertical', 'smrt-core', 'dist'),
      {
        recursive: true,
      },
    );
    writeFileSync(join(member, 'package.json'), '{"name":"web"}');
    const core = join(member, 'node_modules', '@happyvertical', 'smrt-core');
    writeFileSync(
      join(core, 'package.json'),
      '{"name":"@happyvertical/smrt-core","version":"1.0.0"}',
    );
    writeFileSync(
      join(core, 'dist', 'smrt-knowledge.okf.md'),
      '---\npackage_version: "1.0.0"\n---\n# c\n',
    );

    const state = inspectAgentDocs(member);
    expect(state.root).toBe(root);
    expect(state.installed).toBe(true);
    expect(state.bundle).toBe('missing');

    const result = await refreshAgentDocs({
      cwd: member,
      mode: 'if-stale',
      log: sinks().log,
    });
    expect(result.status).toBe('written');
    expect(existsSync(join(root, '.agents/smrt-knowledge/bundle.json'))).toBe(
      true,
    );
    expect(inspectAgentDocs(member).bundle).toBe('fresh');
  });
});

describe('consumer pnpm workspace with a packages/ dir (#4878)', () => {
  const INDEX = `---
type: Index
title: "Developer-intent index"
package_version: 0.0.1
---

# Developer-intent index

| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |
| --- | --- | --- | --- | --- |
| Background work and retries | [background-work](/intents/background-work.md) | [smrt-core](/components/smrt-core.md) | \`withBackgroundJobs\` | \`import:bullmq\` |
`;

  function member(name: string, withCli: boolean): string {
    const dir = join(root, 'apps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `{"name":"${name}"}`);
    const hv = join(dir, 'node_modules', '@happyvertical');
    const core = join(hv, 'smrt-core');
    mkdirSync(join(core, 'dist'), { recursive: true });
    mkdirSync(join(core, 'agents'), { recursive: true });
    writeFileSync(
      join(core, 'package.json'),
      '{"name":"@happyvertical/smrt-core","version":"1.0.0"}',
    );
    writeFileSync(
      join(core, 'AGENTS.md'),
      '# core\n\nCore docs.\n\n| Module | Module doc |\n|---|---|\n| runtime | [agents/runtime.md](agents/runtime.md) |\n',
    );
    writeFileSync(join(core, 'agents', 'runtime.md'), '# runtime\n');
    writeFileSync(
      join(core, 'dist', 'smrt-knowledge.okf.md'),
      '---\ntype: "Component"\npackage_version: "1.0.0"\n---\n\n# core\n',
    );
    if (withCli) {
      const cli = join(hv, 'smrt-cli');
      const intents = join(cli, 'dist', 'knowledge', 'intents');
      mkdirSync(intents, { recursive: true });
      writeFileSync(
        join(cli, 'package.json'),
        '{"name":"@happyvertical/smrt-cli","version":"2.0.0"}',
      );
      writeFileSync(join(intents, 'index.md'), INDEX);
      writeFileSync(join(intents, 'background-work.md'), 'published intent\n');
    }
    return dir;
  }

  function consumerWorkspace(): void {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    mkdirSync(join(root, 'packages'), { recursive: true });
    member('web', true);
    member('api', false);
    // Checkout-shaped inputs a consumer happens to have.
    mkdirSync(join(root, 'docs', 'knowledge', 'intents'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'knowledge', 'intents', 'index.md'),
      INDEX.replace('Background work and retries', 'CONSUMER OWN INTENT'),
    );
    mkdirSync(join(root, '.smrt'), { recursive: true });
    writeFileSync(join(root, '.smrt', 'smrt-knowledge-graph.json'), '{}');
  }

  const framework = () =>
    readFileSync(join(root, '.agents', 'smrt-framework.md'), 'utf-8');

  it('never embeds the consumer AGENTS.md or checkout inputs; reruns are byte-identical', async () => {
    consumerWorkspace();
    const refresh = () =>
      refreshAgentDocs({ cwd: root, mode: 'write', log: sinks().log });

    await refresh();
    // Run 1 created the root AGENTS.md block, so the detector now matches.
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    writeFileSync(
      join(root, 'AGENTS.md'),
      `${readFileSync(join(root, 'AGENTS.md'), 'utf-8')}\nCONSUMER-OWN-TEXT\n`,
    );

    await refresh();
    const second = framework();
    const secondBundle = readFileSync(bundlePath(), 'utf-8');
    const secondIntent = readFileSync(
      join(root, '.agents', 'smrt-knowledge', 'intents', 'background-work.md'),
      'utf-8',
    );
    expect(second).not.toContain('CONSUMER-OWN-TEXT');
    expect(second).not.toContain('## Framework Documentation');
    expect(second).not.toContain('CONSUMER OWN INTENT');
    expect(second).toContain('Background work and retries');
    expect(secondIntent).toBe('published intent\n');
    expect(existsSync(join(root, '.agents', 'smrt-knowledge-graph.json'))).toBe(
      false,
    );

    await refresh();
    expect(framework()).toBe(second);
    expect(readFileSync(bundlePath(), 'utf-8')).toBe(secondBundle);
  });

  it('names module docs under the member that holds them, and they exist', async () => {
    consumerWorkspace();
    await refreshAgentDocs({ cwd: root, mode: 'write', log: sinks().log });
    const doc = framework();
    const links = [...doc.matchAll(/- \[[^\]]+\]\(<([^>]+)>\)/g)].map(
      (match) => match[1],
    );
    const runtime = links.filter((link) => link.endsWith('agents/runtime.md'));
    // Same version in both members: one entry, one primary install location.
    expect(runtime).toEqual([
      'apps/api/node_modules/@happyvertical/smrt-core/agents/runtime.md',
    ]);
    for (const link of links) {
      expect(existsSync(join(root, link))).toBe(true);
    }
  });
});
