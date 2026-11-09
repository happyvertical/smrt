import type { DiagnosticCode } from './diagnostics.js';

/**
 * Internal control-flow failure carrying only a diagnostic code. It has no
 * message, so nothing caught from the filesystem, network or a provider can
 * ride along into output.
 *
 * @internal
 */
export class LauncherFailure extends Error {
  override readonly name = 'LauncherFailure';

  constructor(readonly code: DiagnosticCode) {
    super(code);
  }
}
