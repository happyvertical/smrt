/**
 * The CLI's HTTP transport to the hosted receiver of a desktop user app
 * (`POST /api/shell/app/receive`, #5638, #5193), and `smrt app receive`.
 *
 * It authenticates with a link token the owner minted in the hosted app
 * (`POST /api/shell/app/receive-link`): one tenant, one receive, ten minutes,
 * spent by its first use. The token is an `Authorization: Bearer` header and
 * nothing else: never a URL or query string, never an argument (`smrt app
 * receive` reads it from `SMRT_RECEIVE_TOKEN`), never in a message, a result or
 * a journal. Redirects are refused (a redirect would carry the header to
 * another place), the origin must be https (loopback http for development),
 * and every failure message is scrubbed of the token.
 *
 * `createReceiveTransport` is the `receiveUserApp` that
 * `runSharedCloudMigration` calls; it hands over the section whole and returns
 * the receiver's verified answer, which the journal needs before it records the
 * receive.
 */

import { normalizeCloudOrigin } from '@happyvertical/smrt-app-runtime';
import {
  CloudMigrationError,
  type SharedCloudTransport,
} from './cloud-migration.js';
import { redactSecrets } from './errors.js';
import { serializeExportBundle } from './portability.js';
import { readSensitiveBundle } from './portability-assets.js';
import type { AppContext } from './runtime.js';

/** The receiver route, relative to the hosted origin. */
export const RECEIVE_PATH = '/api/shell/app/receive';
/** Environment variable `smrt app receive` reads the link token from. */
export const RECEIVE_TOKEN_ENV = 'SMRT_RECEIVE_TOKEN';
/** `smrt app receive` usage. */
export const RECEIVE_USAGE = `Usage: smrt app receive --origin <https://hosted origin> --bundle <export file>

Sends the desktop app's user app (from \`smrt app export\`) to the hosted app
as the owner's app. Create a link token as the signed-in owner in the hosted
app (POST /api/shell/app/receive-link) and pass it in ${RECEIVE_TOKEN_ENV}: it
works once, for your own account, for ten minutes. It is never an argument.`;

const TOKEN_SHAPE =
  /^smrt-rl1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_CHARS = 300;

export interface ReceiveTransportOptions {
  /** The hosted origin (the link's origin). https; http only on loopback. */
  origin: string;
  /** The link token minted by the owner. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Answer = Awaited<
  ReturnType<NonNullable<SharedCloudTransport['receiveUserApp']>>
>;

/** Is `value` the shape of a link token (the secret is checked by the server)? */
export function isReceiveToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

function refuse(token: string, message: string): never {
  // The whole token and its secret part, wherever a server echoed either.
  let text = message;
  for (const part of [token, token.split('.')[2]])
    if (part) text = text.split(part).join('[redacted]');
  throw new CloudMigrationError(
    'verification_failed',
    redactSecrets(text, {}, { strict: true }),
  );
}

/** The transport's `receiveUserApp`, bound to one origin and one token. */
export function createReceiveTransport(
  options: ReceiveTransportOptions,
): Pick<SharedCloudTransport, 'receiveUserApp'> {
  const { token } = options;
  if (!isReceiveToken(token))
    throw new CloudMigrationError(
      'plan_refused',
      'The link token is not in the expected form; mint a new one in the hosted app.',
    );
  const origin = normalizeCloudOrigin(options.origin);
  const doFetch = options.fetch ?? fetch;
  return {
    async receiveUserApp(userApp): Promise<Answer> {
      let response: Response;
      try {
        response = await doFetch(`${origin}${RECEIVE_PATH}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: serializeExportBundle({ bundle: userApp }),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        return refuse(
          token,
          `The hosted receiver could not be reached (${error instanceof Error ? error.name : 'error'}); nothing is recorded as received. Rerun with a new token.`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const record = (body ?? {}) as Record<string, unknown>;
      if (!response.ok) {
        const reason =
          typeof record.error === 'string'
            ? record.error.slice(0, MAX_ERROR_CHARS)
            : 'no reason given';
        return refuse(
          token,
          `The hosted receiver refused the user app (HTTP ${response.status}: ${reason}). A refused token is spent: mint a new one to retry.`,
        );
      }
      if (
        (record.status !== 'received' &&
          record.status !== 'already-received') ||
        typeof record.digest !== 'string'
      )
        return refuse(
          token,
          'The hosted receiver answered in an unexpected form.',
        );
      return {
        status: record.status,
        digest: record.digest,
        verified: record.verified === true,
      };
    },
  };
}

/** `smrt app receive`: send the export's user app to the hosted receiver. */
export async function runReceiveOperation(
  context: AppContext,
  args: string[],
  environment: Record<string, string | undefined> = process.env,
): Promise<number> {
  let origin: string | undefined;
  let bundle: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const m = /^--(origin|bundle)(?:=(.*))?$/.exec(flag);
    const value = m ? (m[2] ?? args[++i]) : undefined;
    if (!m || !value || value.startsWith('--'))
      throw new Error(`Unknown or incomplete argument. ${RECEIVE_USAGE}`);
    if (m[1] === 'origin') origin = value;
    else bundle = value;
  }
  if (!origin || !bundle) throw new Error(RECEIVE_USAGE);
  const token = environment[RECEIVE_TOKEN_ENV];
  if (!token)
    throw new Error(
      `Set ${RECEIVE_TOKEN_ENV} to the link token. ${RECEIVE_USAGE}`,
    );
  const parsed = JSON.parse(readSensitiveBundle(bundle)) as {
    application?: unknown;
    userApp?: Parameters<
      NonNullable<SharedCloudTransport['receiveUserApp']>
    >[0];
  };
  if (parsed.application !== context.appId)
    throw new Error('The export belongs to a different application.');
  if (!parsed.userApp)
    throw new Error('The export has no user app section to send.');
  const transport = createReceiveTransport({
    origin,
    token,
    fetch: context.deps.fetch,
  });
  const result = await transport.receiveUserApp?.(parsed.userApp);
  if (!result || result.digest !== parsed.userApp.digest || !result.verified)
    throw new CloudMigrationError(
      'verification_failed',
      'The hosted receiver did not confirm the user app against its digest; nothing was overwritten. Mint a new token and rerun.',
    );
  context.io.stdout(
    `${JSON.stringify({
      schemaVersion: 1,
      status: result.status,
      digest: result.digest,
      verified: true,
    })}\n`,
  );
  return 0;
}
