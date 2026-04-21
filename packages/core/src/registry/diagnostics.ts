/**
 * Registry diagnostic collector.
 *
 * ObjectRegistry's manifest-loading paths previously swallowed failure
 * modes with `console.warn(...); return null`. That was fine for the
 * average case but made #1132-style debugging hard: the only evidence of
 * the problem was fields silently missing at save time.
 *
 * This module is the collection point for those failures. Callers
 * `record()` a diagnostic when they would otherwise `console.warn`; apps
 * and tests can call `ObjectRegistry.getDiagnostics()` to inspect what
 * was missed.
 *
 * Release A shipped the collector as passive (off-by-default strict).
 * Release C (#1134) flips strict mode to **on by default**: severity
 * `'error'` diagnostics now throw at record time so misconfiguration
 * surfaces at registration rather than at silent field-drop time. Opt
 * out with `SMRT_STRICT_REGISTRY=false` if you have manifest-loading
 * paths that must stay permissive (fix the underlying manifest issue
 * instead when you can).
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

/**
 * Strict mode: ON by default (Release C, #1134).
 *
 * When true, severity `'error'` diagnostics throw at record time instead
 * of just appending to the buffer. Set `SMRT_STRICT_REGISTRY=false` to
 * restore the pre-Release-C permissive behavior.
 */
function strictModeEnabled(): boolean {
  return process.env.SMRT_STRICT_REGISTRY !== 'false';
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
    // The opt-out hint is load-bearing when this throw propagates out of a
    // `__smrt-register__.ts` side effect at module-import time — the
    // consumer may have no other recovery path visible in the stack.
    throw new Error(
      `[smrt:${code}] ${message}${suffix} — set SMRT_STRICT_REGISTRY=false ` +
        `to record this diagnostic without throwing.`,
    );
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
