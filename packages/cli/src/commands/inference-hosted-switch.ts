/**
 * `smrt inference:hosted disable | enable | status [--tenant <id>]` — the
 * hosted inference kill switch (#4760), the incident lever.
 *
 * `disable` writes a DISABLE row for `inference.hosted.enabled` in
 * `_smrt_feature_overrides` (global, or `--tenant`); `enable` deletes it.
 * The hosted gate (`@happyvertical/smrt-inference/gate`) reads the switch
 * uncached before every hosted call, so it takes effect on the next call
 * in every process, without a restart and without any model call. A global
 * disable beats everything; enabling a tenant does not lift it.
 *
 * Writing needs only database credentials: the operator running this is
 * the authorization. smrt-features is loaded from the project (the CLI
 * does not depend on it: smrt-features builds with the CLI).
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { InferenceHostedSubcommand } from './inference-hosted.js';

interface SwitchState {
  key: string;
  enabled: boolean;
  disabledBy?: 'global' | 'tenant';
}

interface KillSwitchStore {
  read(
    key: string,
    options: { tenantId?: string | null },
  ): Promise<SwitchState>;
  set(
    key: string,
    options: { enabled: boolean; tenantId?: string | null },
  ): Promise<SwitchState>;
}

/** What the switch subcommands need; tests replace it. */
export interface InferenceHostedSwitchDeps {
  openDatabase(): Promise<{ db: DatabaseInterface; display: string }>;
  closeDatabase(db: DatabaseInterface | undefined): Promise<void>;
  killSwitch(db: DatabaseInterface): Promise<KillSwitchStore>;
}

/**
 * Import a package as the project sees it (its own `node_modules`), then
 * as the CLI sees it.
 */
async function importProjectPackage(specifier: string): Promise<unknown> {
  try {
    const requireFromProject = createRequire(
      resolve(process.cwd(), 'package.json'),
    );
    const entry = requireFromProject.resolve(specifier);
    return await import(pathToFileURL(entry).href);
  } catch {
    return await import(/* @vite-ignore */ specifier);
  }
}

const defaultDeps: InferenceHostedSwitchDeps = {
  async openDatabase() {
    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('../config.js');
    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
    if (!config.database?.url) {
      throw new Error(
        'Database not configured. Set database.url in smrt.config.ts.',
      );
    }
    const dbType = config.database.type || 'sqlite';
    const { getDatabase } = await import('@happyvertical/sql');
    const { formatDatabaseDisplayUrl } = await import('./db-command-utils.js');
    return {
      db: await getDatabase({ type: dbType, url: config.database.url }),
      display: formatDatabaseDisplayUrl(dbType, config.database.url),
    };
  },
  async closeDatabase(db) {
    const { closeDatabaseConnection } = await import('./db-command-utils.js');
    await closeDatabaseConnection(db);
  },
  async killSwitch(db) {
    let features: { KillSwitchService?: new (options: object) => unknown };
    try {
      features = (await importProjectPackage(
        '@happyvertical/smrt-features',
      )) as typeof features;
    } catch (cause) {
      throw new Error(
        'The hosted kill switch is stored by @happyvertical/smrt-features; install it in the project and run `smrt db:migrate`.',
        { cause },
      );
    }
    if (typeof features.KillSwitchService !== 'function') {
      throw new Error(
        'The installed @happyvertical/smrt-features has no KillSwitchService; upgrade it.',
      );
    }
    return new features.KillSwitchService({ db }) as KillSwitchStore;
  },
};

function tenantOption(options: Record<string, unknown>): string | undefined {
  const raw = options.tenant;
  if (raw === undefined || raw === false) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('--tenant needs a tenant id.');
  }
  return raw.trim();
}

/** One line describing a switch state. */
export function formatHostedSwitchState(
  state: SwitchState,
  tenantId?: string,
): string {
  const scope = tenantId ? `tenant ${tenantId}` : 'global';
  if (state.enabled) return `Hosted inference: ENABLED (${scope})`;
  const by =
    state.disabledBy === 'global'
      ? 'disabled globally'
      : `disabled for tenant ${tenantId ?? ''}`.trim();
  return `Hosted inference: DISABLED (${scope}; ${by})`;
}

async function runSwitch(
  action: 'enable' | 'disable' | 'status',
  options: Record<string, unknown>,
  deps: InferenceHostedSwitchDeps,
): Promise<void> {
  let db: DatabaseInterface | undefined;
  try {
    const tenantId = tenantOption(options);
    const opened = await deps.openDatabase();
    db = opened.db;
    const store = await deps.killSwitch(db);
    const { HOSTED_INFERENCE_KILL_SWITCH } = await import(
      '@happyvertical/smrt-inference/gate'
    );
    const scope = tenantId ? { tenantId } : {};
    const state =
      action === 'status'
        ? await store.read(HOSTED_INFERENCE_KILL_SWITCH, scope)
        : await store.set(HOSTED_INFERENCE_KILL_SWITCH, {
            enabled: action === 'enable',
            ...scope,
          });
    if (options.json) {
      console.log(
        JSON.stringify({ action, ...(tenantId ? { tenantId } : {}), ...state }),
      );
      return;
    }
    console.log(`\nDatabase: ${opened.display}`);
    console.log(formatHostedSwitchState(state, tenantId));
    if (action === 'enable' && !state.enabled) {
      console.log(
        '  Still disabled: a global disable outranks a tenant enable. Run `smrt inference:hosted enable` (no --tenant) to lift it.',
      );
    }
    console.log();
  } catch (error) {
    const { redactDatabaseUrlsInText } = await import('./db-command-utils.js');
    const raw = error instanceof Error ? error.message : String(error);
    const hint = /_smrt_feature_overrides/.test(raw)
      ? ' (the feature override table is missing: run `smrt db:migrate` with @happyvertical/smrt-features installed)'
      : '';
    // Redact the driver text alone: the hint names a package scope that a
    // URL redactor would otherwise swallow into a preceding URL.
    const message = `${redactDatabaseUrlsInText(raw)}${hint}`;
    if (options.json) console.log(JSON.stringify({ error: message }));
    else console.error(`\n❌ inference:hosted ${action} failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await deps.closeDatabase(db);
  }
}

/** The kill-switch subcommands, with injectable dependencies for tests. */
export function createInferenceHostedSwitchSubcommands(
  deps: InferenceHostedSwitchDeps = defaultDeps,
): Record<'disable' | 'enable' | 'status', InferenceHostedSubcommand> {
  return {
    disable: {
      usage: 'disable [--tenant <id>]',
      summary:
        'Kill switch: block every hosted AI call now (global, or one tenant)',
      run: (_args, options) => runSwitch('disable', options, deps),
    },
    enable: {
      usage: 'enable [--tenant <id>]',
      summary: 'Lift the kill switch at that scope',
      run: (_args, options) => runSwitch('enable', options, deps),
    },
    status: {
      usage: 'status [--tenant <id>]',
      summary: 'Show the kill switch (no model call)',
      run: (_args, options) => runSwitch('status', options, deps),
    },
  };
}

export const inferenceHostedSwitchSubcommands =
  createInferenceHostedSwitchSubcommands();
