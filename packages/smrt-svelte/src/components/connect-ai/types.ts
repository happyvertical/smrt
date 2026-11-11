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
    Pick<AgentCliStatus, 'tool' | 'installed' | 'signedIn' | 'installUrl'> & {
      login: LoginSnapshot['state'];
    }
  >;
  chatgpt: Pick<ChatGPTPlanStatus, 'signedIn' | 'signingIn'> & {
    error?: { code: NonNullable<ChatGPTPlanStatus['error']>['code'] };
  };
  apiReady: boolean;
}

/** Browser transport; keys and credentials are handled by inference settings, never this API. */
export interface ConnectAiClient {
  state(signal?: AbortSignal): Promise<ConnectAiState>;
  connect(tool: AgentTool, signal?: AbortSignal): Promise<void>;
  choose(engine: InferenceEngineId, signal?: AbortSignal): Promise<void>;
  startChatGPT(signal?: AbortSignal): Promise<{ authorizationUrl?: string }>;
  signOutChatGPT(signal?: AbortSignal): Promise<void>;
}
