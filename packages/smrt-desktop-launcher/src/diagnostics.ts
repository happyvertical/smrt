/**
 * Fixed launcher diagnostics and stable exit codes.
 *
 * Every diagnostic is a constant: no path, origin, token, provider message or
 * child output is ever interpolated, so a diagnostic cannot carry a secret.
 *
 * @packageDocumentation
 */

/** Everything the launcher itself can fail with. */
export type DiagnosticCode =
  | 'missing_install'
  | 'unsupported_contract'
  | 'stale_instance'
  | 'credential_unavailable'
  | 'credential_invalid'
  | 'unexpected_endpoint'
  | 'untrusted_runtime'
  | 'bridge_start_failed'
  | 'bridge_exited'
  | 'internal';

interface DiagnosticEntry {
  readonly exitCode: number;
  readonly message: string;
}

/** The diagnostic table. Exit codes are part of the public contract. */
export const DIAGNOSTICS: Readonly<Record<DiagnosticCode, DiagnosticEntry>> =
  Object.freeze({
    missing_install: {
      exitCode: 10,
      message:
        'The desktop app is not installed or its runtime could not be found. Install or repair the desktop app.',
    },
    unsupported_contract: {
      exitCode: 11,
      message:
        'The installed desktop app uses a launcher contract this plugin does not support. Update the desktop app and the plugin.',
    },
    stale_instance: {
      exitCode: 12,
      message:
        'The desktop app is not running or did not answer. Open the desktop app and try again.',
    },
    credential_unavailable: {
      exitCode: 13,
      message:
        'No assistant credential is available. Open the desktop app, sign in, and connect the assistant.',
    },
    credential_invalid: {
      exitCode: 14,
      message:
        'The assistant credential was rejected or revoked. Reconnect the assistant from the desktop app.',
    },
    unexpected_endpoint: {
      exitCode: 15,
      message:
        'The local instance is not the expected desktop app endpoint. Restart the desktop app.',
    },
    untrusted_runtime: {
      exitCode: 16,
      message:
        'The bundled runtime failed its trust checks and was not started. Reinstall the desktop app.',
    },
    bridge_start_failed: {
      exitCode: 17,
      message:
        'The bundled MCP bridge could not be started. Reinstall the desktop app.',
    },
    bridge_exited: {
      exitCode: 18,
      message: 'The bundled MCP bridge stopped unexpectedly.',
    },
    internal: {
      exitCode: 20,
      message: 'The launcher failed unexpectedly.',
    },
  });

/** Exit status of a launch that ended cleanly. */
export const EXIT_OK = 0;

/** Exit status for a signal-initiated shutdown, by convention `128 + signal`. */
export function signalExitCode(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  };
  return 128 + (numbers[signal] ?? 15);
}

/** The single stderr line for a diagnostic. */
export function formatDiagnostic(name: string, code: DiagnosticCode): string {
  return `${name}: ${code}: ${DIAGNOSTICS[code].message}\n`;
}
