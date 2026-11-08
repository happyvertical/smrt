/**
 * `smrt inference:hosted provision|revoke` (#4759): operator commands over
 * `provisionHostedInference()` / `revokeHostedInference()` from
 * `@happyvertical/smrt-inference/node`. The gateway comes from the
 * `SMRT_INFERENCE_HOSTED_*` environment (see `packages/inference/AGENTS.md`);
 * the database from the CLI config, like `ai:usage`.
 *
 * The `inference:hosted` namespace is shared: #4760 registers `enable` /
 * `disable` in its own module. Each subcommand is its own multi-word entry,
 * so neither clobbers the other.
 *
 * Output never contains the virtual key: only the descriptor (status, alias,
 * non-secret key id, budget).
 */
import type {
  HostedBudgetWindow,
  HostedInferenceBudget,
  HostedInferenceProvisioner,
} from '@happyvertical/smrt-inference/node';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** Parsed options shared by both subcommands. */
export interface InferenceHostedOptions {
  tenant?: string;
  user?: string;
  'budget-micros'?: string;
  'budget-usd'?: string;
  window?: string;
  reason?: string;
  json?: boolean;
}

const WINDOWS: readonly HostedBudgetWindow[] = ['day', 'week', 'month', 'year'];

/**
 * Parse `--budget-micros <int>` or `--budget-usd <decimal>` (exact, at most
 * six decimals, no floating point) plus `--window`.
 */
export function parseHostedBudget(
  options: InferenceHostedOptions,
): HostedInferenceBudget {
  const micros = options['budget-micros'];
  const usd = options['budget-usd'];
  if ((micros === undefined) === (usd === undefined)) {
    throw new Error('Give exactly one of --budget-micros or --budget-usd');
  }
  let limitMicros: number;
  if (micros !== undefined) {
    if (!/^\d+$/.test(String(micros).trim())) {
      throw new Error('--budget-micros must be a positive integer');
    }
    limitMicros = Number(String(micros).trim());
  } else {
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(usd).trim());
    if (!match) {
      throw new Error(
        '--budget-usd must be a decimal amount with at most six decimals',
      );
    }
    limitMicros =
      Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
  }
  if (!Number.isSafeInteger(limitMicros) || limitMicros <= 0) {
    throw new Error('The budget must be greater than zero');
  }
  const window = options.window?.trim().toLowerCase();
  if (window !== undefined && !WINDOWS.includes(window as HostedBudgetWindow)) {
    throw new Error(`--window must be one of ${WINDOWS.join(', ')}`);
  }
  return {
    limitMicros,
    ...(window ? { window: window as HostedBudgetWindow } : {}),
  };
}

function requireOption(
  options: InferenceHostedOptions,
  name: 'tenant' | 'user',
): string {
  const value = options[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Dependencies of {@link runInferenceHosted}; the CLI builds the real ones. */
export interface InferenceHostedDeps {
  provisioner: HostedInferenceProvisioner;
  log?: (line: string) => void;
}

function formatMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `$${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Run one subcommand against `deps`. Returns the descriptor it printed
 * (never containing a key).
 */
export async function runInferenceHosted(
  op: 'provision' | 'revoke',
  options: InferenceHostedOptions,
  deps: InferenceHostedDeps,
): Promise<Record<string, unknown>> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const tenantId = requireOption(options, 'tenant');
  const userId = requireOption(options, 'user');
  const result: Record<string, unknown> =
    op === 'provision'
      ? {
          ...(await deps.provisioner.provision({
            tenantId,
            userId,
            budget: parseHostedBudget(options),
          })),
        }
      : {
          ...(await deps.provisioner.revoke({
            tenantId,
            userId,
            reason: options.reason?.trim() || 'operator',
          })),
        };
  if (options.json) {
    log(JSON.stringify(result, null, 2));
    return result;
  }
  const budget = result.budget as HostedInferenceBudget | undefined;
  if (op === 'provision') {
    log(
      `${result.created ? 'Provisioned' : 'Already provisioned'} hosted inference for user ${userId} in tenant ${tenantId}`,
    );
    log(`  key alias: ${String(result.keyAlias)}`);
    if (result.keyId) log(`  key id:    ${String(result.keyId)}`);
    if (budget) {
      log(
        `  budget:    ${formatMicros(budget.limitMicros)} per ${budget.window ?? 'month'}`,
      );
    }
    if (result.budgetSync) log(`  budget sync: ${String(result.budgetSync)}`);
    if (result.budgetSync === 'unsupported') {
      log(
        '  The installed @happyvertical/ai cannot update key budgets (happyvertical/sdk#1494); the spend gate (#4760) still applies.',
      );
    }
  } else if (!result.revoked) {
    log(`No active hosted inference for user ${userId} in tenant ${tenantId}`);
  } else {
    log(`Revoked hosted inference for user ${userId} in tenant ${tenantId}`);
    log(`  gateway key: ${String(result.gateway)}`);
    log(`  user config: ${String(result.restored)}`);
    if (result.gateway === 'unsupported') {
      log(
        `  Revoke key ${String(result.keyId ?? result.keyAlias)} on the gateway by hand: the installed @happyvertical/ai has no delete call (happyvertical/sdk#1494). SMRT no longer holds or uses the key.`,
      );
    }
  }
  return result;
}

const sharedOptions: CLICommand['options'] = {
  tenant: { type: 'string', description: 'Tenant id (required)' },
  user: { type: 'string', description: 'User id (required)' },
  json: {
    type: 'boolean',
    description: 'Print the result as JSON',
    default: false,
    short: 'j',
  },
};

function handlerFor(op: 'provision' | 'revoke') {
  return async (_args: string[], options: InferenceHostedOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url) {
        throw new Error(
          'Database not configured. Set database.url in smrt.config.ts.',
        );
      }
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({
        type: config.database.type || 'sqlite',
        url: config.database.url,
      });
      const { createHostedInferenceProvisioner } = await import(
        '@happyvertical/smrt-inference/node'
      );
      await runInferenceHosted(op, options, {
        provisioner: createHostedInferenceProvisioner({
          db,
          actor: 'smrt-cli',
        }),
      });
    } catch (error) {
      const message = redactDatabaseUrlsInText(
        error instanceof Error ? error.message : String(error),
      );
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(`\n❌ inference:hosted ${op} failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  };
}

/** `inference:hosted provision|revoke`; #4760 adds `enable|disable` beside them. */
export const inferenceHostedProvisionCommands: Record<string, CLICommand> = {
  'inference:hosted provision': {
    name: 'inference:hosted provision',
    description:
      "Mint a user's hosted inference gateway key with a budget and store it as their provider config (#4759)",
    args: [],
    options: {
      ...sharedOptions,
      'budget-micros': {
        type: 'string',
        description: 'Spend cap in micro-dollars (USD x 1,000,000)',
      },
      'budget-usd': {
        type: 'string',
        description: 'Spend cap in USD, e.g. 20 or 7.50',
      },
      window: {
        type: 'string',
        description: 'Budget reset window: day, week, month (default), year',
      },
    },
    handler: handlerFor('provision'),
  },
  'inference:hosted revoke': {
    name: 'inference:hosted revoke',
    description:
      "Revoke a user's hosted inference key and restore their prior provider config, or mode off (#4759)",
    args: [],
    options: {
      ...sharedOptions,
      reason: {
        type: 'string',
        description: 'Reason recorded in the audit log (default: operator)',
      },
    },
    handler: handlerFor('revoke'),
  },
};
