import type {
  AgentCliStatus,
  AgentTool,
  ChatGPTPlanStatus,
  InferenceEngineId,
  LoginSnapshot,
} from '@happyvertical/smrt-inference/server';

/** Key-free status DTO from the authenticated Connect AI route. */
export interface ConnectAiState {
  engine: InferenceEngineId | null;
  configured: boolean;
  tools: Array<
    Pick<
      AgentCliStatus,
      'tool' | 'installed' | 'signedIn' | 'installUrl' | 'ready' | 'startError'
    > & {
      login: LoginSnapshot['state'];
      label?: string;
      version?: string;
    }
  >;
  chatgpt: Pick<ChatGPTPlanStatus, 'signedIn' | 'signingIn'> & {
    error?: {
      code: NonNullable<ChatGPTPlanStatus['error']>['code'];
      message?: string;
    };
    account?: { label: string };
  };
  apiReady: boolean;
}

/** Browser transport; keys and credentials are handled by inference settings, never this API. */
export interface ConnectAiClient {
  state(signal?: AbortSignal): Promise<ConnectAiState>;
  connect(tool: AgentTool, signal?: AbortSignal): Promise<void>;
  /** Optional compact-host result contract, including a CLI removed between status and click. */
  connectOutcome?(
    tool: AgentTool,
    signal?: AbortSignal,
  ): Promise<{
    result: 'ready' | 'login_started' | 'login_running' | 'missing';
  }>;
  /** Compact hosts may project their own fixed, key-free transport errors. */
  errorMessage?(error: unknown): string;
  choose(engine: InferenceEngineId, signal?: AbortSignal): Promise<void>;
  startChatGPT(signal?: AbortSignal): Promise<{ authorizationUrl?: string }>;
  cancelChatGPT?(signal?: AbortSignal): Promise<void>;
  signOutChatGPT(signal?: AbortSignal): Promise<void>;
  /** Optional host-owned ChatGPT model preference; no credentials. */
  modelState?(signal?: AbortSignal): Promise<{
    model: string | null;
    models?: { id: string; label: string }[];
  }>;
  chooseModel?(model: string | null, signal?: AbortSignal): Promise<void>;
}
