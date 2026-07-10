import { json, type RequestHandler } from '@sveltejs/kit';

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_GATEWAY_HTTP_URL = 'http://voice-gateway.tail8e7e73.ts.net:8080';

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function env(name: string): string | undefined {
  return nonEmpty(process.env[name]);
}

function boolEnv(name: string): boolean {
  const value = env(name)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function httpToWebSocketUrl(httpUrl: string): string {
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ws/voice';
  parsed.search = '';
  return parsed.toString();
}

function authHeaders(token: string | undefined): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export const GET: RequestHandler = async ({ fetch }) => {
  const httpUrl =
    env('SMRT_CHAT_DEV_VOICE_GATEWAY_HTTP_URL') ||
    env('VOICE_GATEWAY_BASE_URL') ||
    DEFAULT_GATEWAY_HTTP_URL;
  const wsUrl =
    env('SMRT_CHAT_DEV_VOICE_GATEWAY_WS_URL') || httpToWebSocketUrl(httpUrl);
  const token =
    env('SMRT_CHAT_DEV_VOICE_GATEWAY_TOKEN') || env('VOICE_GATEWAY_API_TOKEN');
  const exposeToken = boolEnv('SMRT_CHAT_DEV_VOICE_GATEWAY_EXPOSE_TOKEN');
  const defaultTarget = env('SMRT_CHAT_DEV_VOICE_GATEWAY_TARGET') || 'echo';

  let targets: Record<string, Record<string, unknown>> = {
    [defaultTarget]: { adapter: 'configured' },
  };
  let warning: string | undefined;

  try {
    const response = await fetch(`${httpUrl.replace(/\/$/, '')}/v1/targets`, {
      headers: authHeaders(token),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      warning =
        typeof body.detail === 'string'
          ? body.detail
          : `Voice gateway target lookup failed with ${response.status}.`;
    } else if (body.targets && typeof body.targets === 'object') {
      targets = body.targets as Record<string, Record<string, unknown>>;
    }
  } catch (error) {
    warning =
      error instanceof Error
        ? `Voice gateway target lookup failed: ${error.message}`
        : 'Voice gateway target lookup failed.';
  }

  return json({
    configured: Boolean(httpUrl && wsUrl),
    httpUrl,
    wsUrl,
    token: exposeToken ? token : undefined,
    tokenConfigured: Boolean(token),
    tokenExposed: exposeToken && Boolean(token),
    defaultTarget,
    sampleRate: DEFAULT_SAMPLE_RATE,
    targets,
    warning,
  });
};
