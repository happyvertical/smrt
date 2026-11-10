// The MCP credential a local agent CLI turn uses to reach the shell's `/mcp`
// route: an app-runtime local MCP token, owner-bound, scoped to
// `assistant.use` only, with a fixed short lifetime, issued under one holder
// so each new turn rotates (revokes) the last. It is handed to the child by
// environment only and revoked when the turn ends. The value is never logged
// or returned to a browser.
import { ASSISTANT_USE_PERMISSION } from './settings.ts';

export const AGENT_TOKEN_HOLDER = 'shell-assistant';
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
): AgentCredentials {
  return {
    async mint() {
      const tokens = await store();
      if (!tokens) throw new Error('This app has no local token store.');
      const issued = await tokens.issue({
        scopes: [ASSISTANT_USE_PERMISSION],
        expiresInSeconds: AGENT_TOKEN_TTL_SECONDS,
        label: 'Shell assistant',
        holder: AGENT_TOKEN_HOLDER,
      });
      return issued.token;
    },
    async revoke() {
      try {
        await (await store())?.revokeHolder(AGENT_TOKEN_HOLDER);
      } catch {
        // best effort: the token also expires on its own
      }
    },
  };
}
