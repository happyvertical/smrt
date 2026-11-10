/**
 * Container entry point: `node dist/cli.js serve` or `node dist/cli.js migrate`.
 * Configuration comes from the environment (see the package README). Errors
 * print the variable name only, never a value.
 */
import {
  loadServerConfig,
  runMigrations,
  startVaultRelayServer,
} from './server.js';

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === 'migrate') {
    const databaseUrl = process.env.VAULT_RELAY_DATABASE_URL?.trim();
    if (!databaseUrl) {
      process.stderr.write('VAULT_RELAY_DATABASE_URL is required\n');
      return 2;
    }
    await runMigrations({ databaseUrl });
    process.stdout.write('{"level":"info","event":"migrated"}\n');
    return 0;
  }
  if (command === 'serve') {
    const running = await startVaultRelayServer(loadServerConfig());
    const stop = () => {
      running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return -1;
  }
  process.stderr.write('usage: smrt-vault-relay <serve|migrate>\n');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    const message =
      error instanceof Error && error.name === 'VaultRelayConfigError'
        ? error.message
        : 'startup failed';
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event: 'fatal', error: name, message })}\n`,
    );
    process.exit(1);
  },
);
