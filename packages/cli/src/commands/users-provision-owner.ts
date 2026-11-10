import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { closeDatabaseConnection } from './db-command-utils.js';

const FAILURE =
  'Owner provisioning refused. Check the operator input and private database configuration.';
const MAX_SECRET_BYTES = 4096;

/** Read one UTF-8 password, allowing one conventional final newline. */
export async function readOperatorPassword(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SECRET_BYTES) throw new Error(FAILURE);
    chunks.push(bytes);
  }
  const password = new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.concat(chunks))
    .replace(/\r?\n$/, '');
  if (!password || /[\r\n\0]/.test(password)) throw new Error(FAILURE);
  return password;
}

/**
 * Deliberate operator command, never generated from a decorated model. It has
 * no password argument or environment-variable fallback.
 */
export const usersProvisionOwnerCommand: CLICommand = {
  name: 'users:provision-owner',
  description:
    'Provision a PostgreSQL deployment owner using a private file or stdin.',
  args: [],
  options: {
    'tenant-id': { type: 'string', description: 'Stable tenant UUID.' },
    'tenant-name': {
      type: 'string',
      description: 'Exact tenant display name.',
    },
    'user-id': { type: 'string', description: 'Stable owner User UUID.' },
    email: { type: 'string', description: 'Owner email identity.' },
    username: { type: 'string', description: 'Owner username identity.' },
    'password-file': {
      type: 'string',
      description: 'Private password file (0400/0600).',
    },
    'password-stdin': {
      type: 'boolean',
      description: 'Read password from redirected stdin.',
    },
  },
  handler: async (args, options) => {
    let db: DatabaseInterface | undefined;
    try {
      const allowed = new Set(
        Object.keys(usersProvisionOwnerCommand.options ?? {}),
      );
      if (args.length || Object.keys(options).some((key) => !allowed.has(key)))
        throw new Error(FAILURE);
      const file = options['password-file'];
      const stdin = options['password-stdin'] === true;
      if ((typeof file === 'string' && !!file) === stdin || (!file && !stdin))
        throw new Error(FAILURE);
      let password: string;
      if (stdin) {
        if (process.stdin.isTTY) throw new Error(FAILURE);
        password = await readOperatorPassword(process.stdin);
      } else {
        if (typeof file !== 'string') throw new Error(FAILURE);
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            (stat.mode & 0o077) !== 0 ||
            stat.size > MAX_SECRET_BYTES
          )
            throw new Error(FAILURE);
          password = await readOperatorPassword(
            createReadStream('', { fd: handle.fd, autoClose: false }),
          );
        } finally {
          await handle.close();
        }
      }
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (config.database?.type !== 'postgres' || !config.database.url)
        throw new Error(FAILURE);
      const { getDatabase } = await import('@happyvertical/sql');
      const { provisionPasswordOwner } = await import(
        '@happyvertical/smrt-users/operator'
      );
      db = await getDatabase({ type: 'postgres', url: config.database.url });
      const result = await provisionPasswordOwner(db, {
        tenantId: options['tenant-id'] as string,
        tenantName: options['tenant-name'] as string,
        userId: options['user-id'] as string,
        email: options.email as string | undefined,
        username: options.username as string | undefined,
        password,
      });
      console.log(`Owner provisioning ${result.status}.`);
    } catch {
      console.error(FAILURE);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
