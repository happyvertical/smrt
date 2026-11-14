// "Connect": start the tool's OWN sign-in (`claude auth login`, `codex login`).
// The tool opens the vendor's page in the system browser and finishes the
// sign-in itself; this app sees only whether the process ended, then asks the
// tool's status command again. No credential, code or token passes through
// here, and nothing is read from the tool's files.
import { cliEnv, locateCli } from './detect.js';
import { defaultLocateDeps, type LocateDeps } from './locate.js';
import { runProcess } from './runner.js';
import { AGENT_TOOL_INFO, type AgentTool } from './tools.js';

/** How long a person has to finish signing in. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export type LoginState = 'idle' | 'running' | 'finished' | 'failed';

export interface LoginSnapshot {
  state: LoginState;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

export class AgentLogin {
  private readonly running = new Map<AgentTool, Running>();
  private readonly last = new Map<AgentTool, LoginState>();

  constructor(
    private readonly options: {
      deps?: LocateDeps;
      timeoutMs?: number;
      /** Called when a sign-in process ends, so cached status is dropped. */
      onEnd?(tool: AgentTool): void;
    } = {},
  ) {}

  snapshot(tool: AgentTool): LoginSnapshot {
    if (this.running.has(tool)) return { state: 'running' };
    return { state: this.last.get(tool) ?? 'idle' };
  }

  /**
   * Start the tool's sign-in. `started` / `running` (one is already open) /
   * `missing` (the tool is not installed).
   */
  async start(tool: AgentTool): Promise<'started' | 'running' | 'missing'> {
    if (this.running.has(tool)) return 'running';
    const deps = this.options.deps ?? defaultLocateDeps();
    const location = await locateCli(tool, deps);
    if (!location) return 'missing';
    if (this.running.has(tool)) return 'running';
    const controller = new AbortController();
    const info = AGENT_TOOL_INFO[tool];
    const done = runProcess({
      command: location.path,
      args: info.loginArgs,
      env: cliEnv(location, deps.env),
      signal: controller.signal,
      timeoutMs: this.options.timeoutMs ?? LOGIN_TIMEOUT_MS,
    }).then((result) => {
      this.running.delete(tool);
      this.last.set(tool, result.exitCode === 0 ? 'finished' : 'failed');
      this.options.onEnd?.(tool);
    });
    this.running.set(tool, { controller, done });
    this.last.delete(tool);
    return 'started';
  }

  /** Stop an open sign-in (the person closed the dialog). */
  cancel(tool: AgentTool): void {
    this.running.get(tool)?.controller.abort();
  }

  /** Tests: wait until the sign-in process has ended. */
  async settled(tool: AgentTool): Promise<void> {
    await this.running.get(tool)?.done;
  }
}
