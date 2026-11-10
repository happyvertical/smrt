// The two local agent CLIs the shell can drive, and nothing else about them
// than what their own `--help` documents. The shell never reads either tool's
// credential files or keychain items: whether a person is signed in is asked
// of the tool's own status command, and signing in is the tool's own login
// flow (it opens the vendor's page in the system browser).
//
// Legal rule (https://code.claude.com/docs/en/legal-and-compliance): the app
// does not offer Claude.ai or ChatGPT login itself and never collects, stores
// or passes on those credentials. It only runs the person's own, unmodified
// CLI, which they signed in through the vendor's own flow and which bills
// them. Names appear as plain text, no logos.

export const AGENT_TOOLS = ['claude-code', 'codex'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export function isAgentTool(value: unknown): value is AgentTool {
  return (AGENT_TOOLS as readonly unknown[]).includes(value);
}

export interface AgentToolInfo {
  tool: AgentTool;
  /** Plain-text product name for the UI. */
  label: string;
  /** The executable name looked up on PATH and in the usual install places. */
  binary: string;
  /** Where to send a person who has not installed it. */
  installUrl: string;
  versionArgs: readonly string[];
  /** The tool's own status command: exit 0 / `loggedIn` means signed in. */
  statusArgs: readonly string[];
  /** The tool's own interactive sign-in (opens the vendor page itself). */
  loginArgs: readonly string[];
}

export const AGENT_TOOL_INFO: Readonly<Record<AgentTool, AgentToolInfo>> = {
  'claude-code': {
    tool: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    installUrl: 'https://code.claude.com/docs/en/setup',
    versionArgs: ['--version'],
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
  },
  codex: {
    tool: 'codex',
    label: 'Codex',
    binary: 'codex',
    installUrl: 'https://developers.openai.com/codex/cli',
    versionArgs: ['--version'],
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
  },
};
