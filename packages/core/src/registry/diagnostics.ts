/**
 * Registry diagnostic collector.
 *
 * Currently ObjectRegistry's manifest-loading paths swallow a number of
 * failure modes with `console.warn(...); return null`. That is fine for the
 * average case — a missing or malformed manifest from one package shouldn't
 * crash the whole app — but it makes #1132-style debugging hard: the only
 * evidence of the problem is fields silently missing at save time.
 *
 * This module provides an opt-in collection point for those silent failures.
 * Callers `record()` a diagnostic when they would otherwise `console.warn`;
 * apps and tests can later call `ObjectRegistry.getDiagnostics()` to inspect
 * what was missed.
 *
 * Release A ships this as **passive** — diagnostics accumulate but never
 * throw. Release C (see #1134) flips `SMRT_STRICT_REGISTRY` on by default,
 * at which point severity `'error'` diagnostics will throw at record time.
 *
 * @see https://github.com/happyvertical/smrt/issues/1132
 * @see https://github.com/happyvertical/smrt/issues/1134
 */

export type RegistryDiagnosticSeverity = 'warn' | 'error';

export interface RegistryDiagnostic {
  severity: RegistryDiagnosticSeverity;
  /** Stable machine-readable identifier, e.g., 'MANIFEST_LOAD_FAILED'. */
  code: string;
  /** Short human message. */
  message: string;
  /** Optional structured context (package name, path, etc.). */
  context?: Record<string, unknown>;
  /** Captured at record time. */
  timestamp: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __smrtRegistryDiagnostics: RegistryDiagnostic[] | undefined;
}

function getBuffer(): RegistryDiagnostic[] {
  if (!globalThis.__smrtRegistryDiagnostics) {
    globalThis.__smrtRegistryDiagnostics = [];
  }
  return globalThis.__smrtRegistryDiagnostics;
}

function strictModeEnabled(): boolean {
  return process.env.SMRT_STRICT_REGISTRY === 'true';
}

/**
 * Record a diagnostic from a registry load path.
 *
 * Always appends to the buffer. In strict mode (`SMRT_STRICT_REGISTRY=true`),
 * severity `'error'` diagnostics also throw so the failure surfaces at the
 * site of the drop instead of later during field access.
 */
export function recordRegistryDiagnostic(
  severity: RegistryDiagnosticSeverity,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const diagnostic: RegistryDiagnostic = {
    severity,
    code,
    message,
    context,
    timestamp: Date.now(),
  };
  getBuffer().push(diagnostic);

  if (severity === 'error' && strictModeEnabled()) {
    const suffix = context ? ` (${JSON.stringify(context)})` : '';
    throw new Error(`[smrt:${code}] ${message}${suffix}`);
  }
}

/** Snapshot of diagnostics recorded so far. */
export function getRegistryDiagnostics(): readonly RegistryDiagnostic[] {
  return [...getBuffer()];
}

/** Clear the diagnostic buffer — typically used in tests. */
export function clearRegistryDiagnostics(): void {
  getBuffer().length = 0;
}

/**
 * Pretty-print the diagnostic buffer to `console.warn` / `console.error`.
 * Apps can call this at startup or on an error route to surface anything the
 * registry swallowed. Does nothing if the buffer is empty.
 */
export function flushRegistryDiagnostics(): void {
  const diagnostics = getBuffer();
  if (diagnostics.length === 0) {
    return;
  }

  for (const diag of diagnostics) {
    const line = `[smrt:${diag.code}] ${diag.message}`;
    if (diag.severity === 'error') {
      console.error(line, diag.context ?? '');
    } else {
      console.warn(line, diag.context ?? '');
    }
  }
}
