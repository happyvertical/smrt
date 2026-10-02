import type { CLICommand } from '../cli-generator.js';

/** Require an executable fixture command while preserving its method receiver. */
export function requireCommandHandler(
  command: CLICommand,
): NonNullable<CLICommand['handler']> {
  const handler = command.handler;
  if (typeof handler !== 'function') {
    throw new Error(`Expected ${command.name} to define a handler`);
  }
  return handler.bind(command);
}
