// A host-supplied owner MCP token: child environment only, never argv, files,
// logs or browser events. Scope, identity and holder are chosen by the host;
// its token store owns rotation. The engine revokes it when the turn ends.

/** Longer than a turn may run, so a slow turn never loses its token. */
export const AGENT_TOKEN_TTL_SECONDS = 15 * 60;

export interface AgentCredentials {
  /** Mint the token for one turn (rotating any earlier one). */
  mint(): Promise<string>;
  /** Revoke it. Safe to call twice. */
  revoke(): Promise<void>;
}

/** The slice of app-runtime's `LocalMcpTokenStore` used here. */
export interface McpTokenStoreLike {
  issue(input: {
    scopes: readonly string[];
    expiresInSeconds?: number;
    label?: string;
    holder?: string;
  }): Promise<{ token: string }>;
  revokeHolder(holder: string): Promise<'revoked' | 'none'>;
}

export function tokenCredentials(
  store: () => Promise<McpTokenStoreLike | undefined>,
  options: { holder: string; scopes: readonly string[]; label: string },
): AgentCredentials {
  return {
    async mint() {
      const tokens = await store();
      if (!tokens) throw new Error('This app has no local token store.');
      const issued = await tokens.issue({
        scopes: options.scopes,
        expiresInSeconds: AGENT_TOKEN_TTL_SECONDS,
        label: options.label,
        holder: options.holder,
      });
      return issued.token;
    },
    async revoke() {
      try {
        await (await store())?.revokeHolder(options.holder);
      } catch {
        // best effort: the token also expires on its own
      }
    },
  };
}
