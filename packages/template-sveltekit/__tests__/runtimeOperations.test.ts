/**
 * The generated app's operational surface after #3371: every lifecycle
 * script is a `smrt app <op>` one-liner and the app ships no `scripts/`.
 *
 * The operations themselves (storage custody, writer lease, operation lock,
 * owner-bootstrap handoff, start/stop identity, ORIGIN propagation, workers,
 * backup/export/import, migrations) are proven where they now live:
 * `packages/cli/src/app/__tests__` and app-runtime's
 * `src/operator-primitives.test.ts` (which carry this file's former cases).
 * This file proves the template is wired to those commands, and that the
 * deployment topology still runs separate web, task, and schedule processes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_OWNER_SETUP_MESSAGES } from '@happyvertical/smrt-app-runtime/sveltekit';
import { APP_COMMANDS, APP_OPERATIONS } from '@happyvertical/smrt-cli/app';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '..', 'template');
const templatePackage = JSON.parse(
  readFileSync(join(template, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const compose = readFileSync(join(template, 'compose.yaml'), 'utf8');
const dockerfile = readFileSync(join(template, 'Dockerfile'), 'utf8');

/** First word of each `smrt app` command signature (`'worker [task|schedule]'` → `worker`). */
const commandNames = new Set(
  Object.keys(APP_COMMANDS).map((signature) => signature.split(' ')[0]),
);

function templateFiles(directory = template): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? templateFiles(path) : [path];
  });
}

describe('application lifecycle commands', () => {
  it('ships no copied operator scripts', () => {
    expect(existsSync(join(template, 'scripts'))).toBe(false);
    // Nothing the app ships may still point at a deleted script. README and
    // AGENTS prose is checked by documentation.test.ts.
    for (const file of templateFiles()) {
      if (/\/(README|AGENTS|INSTALL_PROMPT)\.md$/.test(file)) continue;
      expect(
        readFileSync(file, 'utf8'),
        relative(template, file),
      ).not.toMatch(/scripts\/smrt-[a-z-]+\.mjs/);
    }
  });

  it('maps every app:* script onto a real smrt app operation', () => {
    for (const operation of APP_OPERATIONS) {
      expect(templatePackage.scripts[`app:${operation}`]).toBe(
        `smrt app ${operation}`,
      );
    }
    const appScripts = Object.keys(templatePackage.scripts).filter((name) =>
      name.startsWith('app:'),
    );
    expect(appScripts.sort()).toEqual(
      APP_OPERATIONS.map((operation) => `app:${operation}`).sort(),
    );
  });

  it('runs dev, build, preview, migrations, and workers through the CLI', () => {
    expect(templatePackage.scripts).toMatchObject({
      dev: 'smrt app dev',
      build: 'smrt app build',
      preview: 'smrt app start',
      // Build first so the migration uses fresh generated artifacts; the
      // command holds the operation lock and refuses while a writer is live.
      'db:migrate': 'vite build && smrt app migrate',
      worker: 'smrt app worker task',
      'worker:schedule': 'smrt app worker schedule',
    });
    for (const script of Object.values(templatePackage.scripts)) {
      const match = /^smrt app (\S+)/.exec(script.split('&& ').at(-1) ?? '');
      if (match) expect(commandNames, script).toContain(match[1]);
    }
    expect(JSON.stringify(templatePackage)).not.toContain('db:setup');
  });

  it('names a complete stopped-recovery sequence the scripts provide', () => {
    // The setup page's fixed failure tells the owner what to run next; every
    // command it names must exist in this app.
    const steps = DEFAULT_OWNER_SETUP_MESSAGES.setup_invalid.match(
      /pnpm (app:[a-z]+)/g,
    );
    expect(steps).toEqual([
      'pnpm app:stop',
      'pnpm app:recover',
      'pnpm app:start',
      'pnpm app:open',
    ]);
    for (const step of steps ?? []) {
      expect(templatePackage.scripts).toHaveProperty(step.slice('pnpm '.length));
    }
  });
});

describe('deployed process topology', () => {
  it('provides separate web, task-worker, and schedule-worker processes', () => {
    expect(compose).toContain('command: node build');
    expect(compose).toContain('command: pnpm exec smrt app worker task');
    expect(compose).toContain('command: pnpm exec smrt app worker schedule');
    expect(compose).toContain('migrate:');
    expect(compose).toContain('command: pnpm app:setup');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('${POSTGRES_PASSWORD:?');
    expect(compose).toContain('${DATABASE_URL:?');
    expect(compose).not.toContain('change-me');
  });

  it('keeps what the workers and operator commands need in the runtime image', () => {
    // The CLI is a devDependency; workers and app:doctor/export/import run it.
    expect(dockerfile).toContain(
      'RUN pnpm install --frozen-lockfile --prod=false',
    );
    expect(dockerfile).not.toContain('pnpm install --prod ');
    // Workers import the build-compiled registration (#3117) and read the
    // profile from smrt.config.ts.
    expect(dockerfile).toContain('COPY --from=build /app/.smrt ./.smrt');
    expect(dockerfile).toContain(
      'COPY --from=build /app/smrt.config.ts ./smrt.config.ts',
    );
    expect(dockerfile).not.toContain('/app/scripts');
    expect(dockerfile).toContain('ENV SMRT_RUNTIME_PROFILE=self-hosted');
    expect(dockerfile).toContain('USER node');
  });
});
