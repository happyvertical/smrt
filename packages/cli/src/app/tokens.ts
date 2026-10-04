/**
 * `smrt app token` — owner-minted bearer tokens for local MCP clients.
 *
 * ```
 * smrt app token --scopes notes.read [--expires 30d] [--label "Claude Desktop"]
 * smrt app token list
 * smrt app token revoke <id>
 * ```
 *
 * Local profile only. The token is printed once, in the `issued` JSON
 * document on stdout, and is otherwise never written anywhere: the runtime
 * stores only its HMAC. `list` and `revoke` output carries no token values.
 */

import {
  openLocalMcpTokenStore,
  withOperationLock,
} from '@happyvertical/smrt-app-runtime';
import { assertLocalOperation } from './operations.js';
import { type AppContext, preparedStateRoot } from './runtime.js';

/** Usage text for `smrt app token`. */
export const TOKEN_USAGE =
  'Usage: smrt app token [create] --scopes <scope[,scope...]> [--expires <n>s|m|h|d] [--label <text>] | token list | token revoke <id>';

interface CreateArgs {
  scopes: string[];
  expiresInSeconds?: number;
  label?: string;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/** Parse `30d`, `12h`, `90m`, `3600s` or bare seconds. */
export function parseTokenLifetime(value: string): number {
  const match = /^([1-9][0-9]{0,8})([smhd]?)$/u.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid --expires value. ${TOKEN_USAGE}`);
  }
  return Number(match[1]) * UNIT_SECONDS[match[2] || 's'];
}

function parseCreateArgs(args: string[]): CreateArgs {
  const scopes: string[] = [];
  let expiresInSeconds: number | undefined;
  let label: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = arg.indexOf('=');
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (!['--scopes', '--scope', '--expires', '--label'].includes(name)) {
      throw new Error(`Unknown token option: ${name}. ${TOKEN_USAGE}`);
    }
    const value = equals > 0 ? arg.slice(equals + 1) : args[++index];
    if (value === undefined || (equals < 0 && value.startsWith('--'))) {
      throw new Error(`Token option ${name} requires a value. ${TOKEN_USAGE}`);
    }
    if (name === '--scopes' || name === '--scope') {
      scopes.push(...value.split(/[\s,]+/u).filter(Boolean));
    } else if (name === '--expires') {
      if (expiresInSeconds !== undefined) {
        throw new Error('Token option --expires was provided more than once.');
      }
      expiresInSeconds = parseTokenLifetime(value);
    } else {
      if (label !== undefined) {
        throw new Error('Token option --label was provided more than once.');
      }
      label = value;
    }
  }
  if (scopes.length === 0) {
    throw new Error(`At least one scope is required. ${TOKEN_USAGE}`);
  }
  return { scopes, expiresInSeconds, label };
}

function printJson(context: AppContext, value: unknown): void {
  context.io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** Run `smrt app token <args…>` and resolve to the exit code. */
export async function runTokenOperation(
  context: AppContext,
  args: string[],
): Promise<number> {
  const [first, ...rest] = args;
  // Help before the implicit `create`: `--help` is not a create option.
  if (first === 'help' || first === '--help' || first === '-h') {
    context.io.stdout(`${TOKEN_USAGE}\n`);
    return 0;
  }
  const subcommand =
    first === undefined || first.startsWith('--') ? 'create' : first;
  const subArgs = subcommand === first ? rest : args;
  if (!['create', 'list', 'revoke'].includes(subcommand)) {
    throw new Error(`Unknown token operation: ${subcommand}. ${TOKEN_USAGE}`);
  }
  // Validate arguments before touching any state.
  const create = subcommand === 'create' ? parseCreateArgs(subArgs) : null;
  if (subcommand === 'list' && subArgs.length > 0) {
    throw new Error(`token list takes no arguments. ${TOKEN_USAGE}`);
  }
  if (subcommand === 'revoke' && subArgs.length !== 1) {
    throw new Error(`token revoke takes exactly one token id. ${TOKEN_USAGE}`);
  }
  await assertLocalOperation(context, 'app:token');

  const open =
    context.deps.runtime.openLocalMcpTokenStore ?? openLocalMcpTokenStore;
  const withStore = async <T>(
    fn: (store: Awaited<ReturnType<typeof open>>) => Promise<T>,
  ): Promise<T> => {
    const store = await open({
      appId: context.appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot: context.sourceRoot,
    });
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  };

  if (subcommand === 'list') {
    const tokens = await withStore((store) => store.list());
    printJson(context, {
      schemaVersion: 1,
      status: 'ok',
      tokens,
      secretValuesIncluded: false,
    });
    return 0;
  }

  // Writes serialize with setup/import/backup through the operation lock.
  // The web process may keep running: no writer lease is taken.
  return withOperationLock(
    preparedStateRoot(context),
    `token-${subcommand}`,
    async () => {
      if (create) {
        const issued = await withStore((store) => store.issue(create));
        printJson(context, {
          schemaVersion: 1,
          status: 'issued',
          id: issued.id,
          token: issued.token,
          scopes: issued.scopes,
          label: issued.label,
          createdAt: issued.createdAt,
          expiresAt: issued.expiresAt,
          notice:
            'This token is shown once and only its hash is stored. Put it in your MCP client configuration now; revoke it with smrt app token revoke <id>.',
          secretValuesIncluded: true,
        });
        return 0;
      }
      const id = subArgs[0];
      const outcome = await withStore((store) => store.revoke(id));
      printJson(context, {
        schemaVersion: 1,
        status: outcome,
        id,
        secretValuesIncluded: false,
      });
      return 0;
    },
  );
}
