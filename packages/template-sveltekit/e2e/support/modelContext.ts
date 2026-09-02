/**
 * The single deterministic test boundary this gate installs in the browser.
 *
 * No headless browser ships the WebMCP origin trial, so `document.modelContext`
 * has to come from somewhere. It comes from here — and from nowhere else. This
 * script is a *host*, not a mock of the application: it records what the page
 * registers and forwards `execute()` straight through to the page's own tool
 * implementation, which then talks to the real server over the real session.
 *
 * It never confirms, approves, or elevates anything on the user's behalf.
 */

/** Shape recorded for each registration, mirrored into the page for assertion. */
export interface RecordedRegistration {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: Record<string, unknown>;
  readonly inputSchema?: Record<string, unknown>;
  readonly aborted: boolean;
  /** Monotonic registration order, so duplicate registrations are visible. */
  readonly sequence: number;
}

declare global {
  interface Window {
    /** Test-boundary handle; present only under this harness. */
    __m5ModelContext?: {
      registrations(): RecordedRegistration[];
      live(): RecordedRegistration[];
      execute(name: string, args?: Record<string, unknown>): Promise<string>;
      confirmations: number;
    };
  }
}

/**
 * Serialized into every browser context via `addInitScript`. Runs before any
 * application script, so the page's feature detection sees WebMCP support on
 * its very first evaluation.
 */
export function installModelContext(): void {
  const records: {
    name: string;
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    signal: AbortSignal;
    execute: (args: Record<string, unknown>) => Promise<string> | string;
    sequence: number;
  }[] = [];
  let sequence = 0;

  const snapshot = (entry: (typeof records)[number]) => ({
    name: entry.name,
    description: entry.description,
    annotations: entry.annotations,
    inputSchema: entry.inputSchema,
    aborted: entry.signal.aborted,
    sequence: entry.sequence,
  });

  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      async registerTool(
        tool: {
          name: string;
          description?: string;
          annotations?: Record<string, unknown>;
          inputSchema?: Record<string, unknown>;
          execute: (args: Record<string, unknown>) => Promise<string> | string;
        },
        options?: { signal?: AbortSignal },
      ) {
        sequence += 1;
        records.push({
          name: tool.name,
          description: tool.description,
          annotations: tool.annotations,
          inputSchema: tool.inputSchema,
          // A registration with no signal can never be disposed; represent
          // that faithfully rather than inventing an abortable one.
          signal: options?.signal ?? new AbortController().signal,
          execute: tool.execute,
          sequence,
        });
      },
    },
  });

  window.__m5ModelContext = {
    // Every registration ever seen, including disposed ones.
    registrations: () => records.map(snapshot),
    // Registrations whose owner has not disposed them.
    live: () => records.filter((entry) => !entry.signal.aborted).map(snapshot),
    async execute(name: string, args: Record<string, unknown> = {}) {
      const entries = records.filter(
        (entry) => entry.name === name && !entry.signal.aborted,
      );
      if (entries.length === 0) {
        throw new Error(`No live WebMCP tool named ${name}.`);
      }
      if (entries.length > 1) {
        throw new Error(`Duplicate live WebMCP registrations for ${name}.`);
      }
      return String(await entries[0]!.execute(args));
    },
    // Stays zero for the whole run: the harness has no consent path, so a
    // write that reached the model context would have nothing to approve it.
    confirmations: 0,
  };
}
