/**
 * Guards the credential scope of `.github/workflows/app-runtime-windows.yml`
 * (smrt#4837 W2). That job runs pull-request code on a Windows runner, so the
 * GitHub Packages token may exist in the install step only: never at workflow
 * or job level, never in a later step's environment, and never left in a
 * file for a later step to read.
 *
 * Host-independent on purpose (it parses the workflow, it does not run it) and
 * not named `windows-custody*`, so the Windows job itself does not select it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW = fileURLToPath(
  new URL(
    '../../../.github/workflows/app-runtime-windows.yml',
    import.meta.url,
  ),
);

interface Step {
  name: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
}

const present = existsSync(WORKFLOW);
const source = present ? readFileSync(WORKFLOW, 'utf8') : '';
const workflow = (present ? parse(source) : {}) as Workflow;
const steps = workflow.jobs?.custody?.steps ?? [];
const INSTALL = 'Install dependencies';

describe.skipIf(!present)('app-runtime-windows workflow credentials', () => {
  it('keeps the token read-only and out of workflow and job scope', () => {
    expect(workflow.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
    expect(workflow.env).toBeUndefined();
    expect(workflow.jobs.custody.env).toBeUndefined();
  });

  it('mentions the token in the install step and in no other step', () => {
    const holders = steps
      .filter(
        (step) =>
          /GITHUB_TOKEN|secrets\./.test(JSON.stringify(step)) ||
          'NODE_AUTH_TOKEN' in (step.env ?? {}),
      )
      .map((step) => step.name);
    expect(holders).toEqual([INSTALL]);
    // Other steps may only talk about the token to prove it is gone.
    for (const step of steps.filter(
      (candidate) => candidate.name !== INSTALL,
    )) {
      expect(Object.keys(step.env ?? {})).not.toContain('NODE_AUTH_TOKEN');
      expect(JSON.stringify(step.env ?? {})).not.toMatch(/secrets\./);
    }
  });

  it('gives the token to the install step through step-level env only', () => {
    const install = steps.find((step) => step.name === INSTALL) as Step;
    expect(install.env).toEqual({
      NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(install.run).toContain('pnpm install');
    // Never an expression in the script body, where it would be inlined.
    expect(install.run).not.toContain('${{');
  });

  it('never writes the token into the home .npmrc and removes its own config', () => {
    const run = (steps.find((step) => step.name === INSTALL) as Step)
      .run as string;
    expect(run).not.toMatch(/(?:HOME|~)[^\n]*\.npmrc/);
    expect(run).toMatch(/trap '[^']*rm -f[^']*' EXIT/);
    expect(run).toContain('NPM_CONFIG_USERCONFIG');
    // Written by reference (single-quoted, so the shell does not expand it).
    expect(run).toContain(
      "'//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'",
    );
    expect(run).not.toMatch(/"[^"\n]*_authToken=\$\{NODE_AUTH_TOKEN\}"/);
  });

  it('proves the credential is gone before any step runs pull-request code', () => {
    const names = steps.map((step) => step.name);
    const install = names.indexOf(INSTALL);
    const check = names.indexOf('Check no registry credential remains');
    const firstCode = names.indexOf('Build the dependency closure');
    const tests = names.indexOf('Windows custody tests');
    expect(install).toBeGreaterThan(-1);
    expect(check).toBe(install + 1);
    expect(firstCode).toBeGreaterThan(check);
    expect(tests).toBeGreaterThan(firstCode);
    const guard = steps[check].run as string;
    expect(guard).toContain('NODE_AUTH_TOKEN');
    expect(guard).toContain('_authToken');
    expect(guard).toMatch(/exit 1/);
  });

  it('does not persist the checkout credential', () => {
    const checkout = steps.find((step) =>
      step.uses?.startsWith('actions/checkout'),
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('runs on Windows and watches the cli app commands', () => {
    expect(workflow.jobs.custody).toMatchObject({
      'runs-on': 'windows-latest',
    });
    const on = (parse(source) as { on: { pull_request: { paths: string[] } } })
      .on;
    expect(on.pull_request.paths).toEqual(
      expect.arrayContaining([
        'packages/app-runtime/**',
        'packages/cli/src/app/**',
        '.github/workflows/app-runtime-windows.yml',
      ]),
    );
  });
});
