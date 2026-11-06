import { LocalRuntimeError } from '@happyvertical/smrt-app-runtime';
import type { SmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit-runtime';
import type { RequestEvent } from '@sveltejs/kit';
import { isLoopbackRequest } from './owner-setup.js';

const MAX_REQUEST_BYTES = 12 * 1024;

type CredentialEvent = Pick<
  RequestEvent,
  'request' | 'url' | 'getClientAddress' | 'cookies'
>;

function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(status === 405 ? { Allow: 'POST' } : {}),
    },
  });
}

async function readPayload(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    const data: unknown = JSON.parse(json + decoder.decode());
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    return data as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Opt-in POST endpoint for the local desktop owner. Mount only on a direct
 * loopback listener, with no proxy-derived client address or origin headers.
 */
export function createLocalMcpCredentialHandler(
  runtime: Pick<
    SmrtSvelteKitRuntime,
    'resolvedRuntime' | 'localRuntime' | 'sessionCookie'
  >,
): (event: CredentialEvent) => Promise<Response> {
  return async (event) => {
    try {
      const { request, url } = event;
      if (request.method !== 'POST') {
        return reply(405, { code: 'method_not_allowed' });
      }
      const fetchSite = request.headers.get('sec-fetch-site');
      if (
        !isLoopbackRequest(event) ||
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        request.headers.get('host') !== url.host ||
        request.headers.get('origin') !== url.origin ||
        (fetchSite !== null && fetchSite !== 'same-origin')
      ) {
        return reply(403, { code: 'forbidden' });
      }
      if ((await runtime.resolvedRuntime()).profile !== 'local') {
        return reply(404, { code: 'unavailable' });
      }
      const sessionId = event.cookies.get(runtime.sessionCookie.name);
      if (!sessionId) return reply(403, { code: 'forbidden' });
      const local = await runtime.localRuntime();
      const store = local.mcpTokens;
      if (!store?.manageDesktopCredential) {
        return reply(404, { code: 'unavailable' });
      }

      // Resolve the cookie through the normal session service. Request locals,
      // bearer credentials and payload claims cannot supply an actor.
      const session = await local.restoreSession(sessionId);
      if (
        !session?.user.id ||
        !session.tenantId ||
        !session.membership?.isActive() ||
        session.parent ||
        session.permissionCeiling !== null ||
        !['local-bootstrap', 'password', 'passkey'].includes(
          session.authMethod ?? '',
        )
      ) {
        return reply(403, { code: 'forbidden' });
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0];
      if (mediaType?.trim().toLowerCase() !== 'application/json') {
        return reply(415, { code: 'unsupported_media_type' });
      }
      const data = await readPayload(request);
      if (!data || typeof data.id !== 'string') {
        return reply(400, { code: 'invalid_request' });
      }
      const actor = {
        userId: session.user.id,
        tenantId: session.tenantId,
        permissions: session.permissions,
      };
      if (data.action === 'revoke' && Object.keys(data).length === 2) {
        const result = await store.manageDesktopCredential(actor, {
          action: 'revoke',
          id: data.id,
        });
        return result === 'revoked'
          ? reply(200, { status: 'revoked' })
          : reply(409, { code: 'slot_unavailable' });
      }
      if (
        data.action !== 'put' ||
        Object.keys(data).length !== 4 ||
        !Array.isArray(data.scopes) ||
        typeof data.expiresInSeconds !== 'number'
      ) {
        return reply(400, { code: 'invalid_request' });
      }
      const issued = await store.manageDesktopCredential(actor, {
        action: 'put',
        id: data.id,
        scopes: data.scopes,
        expiresInSeconds: data.expiresInSeconds,
      });
      if (typeof issued === 'string') {
        return reply(409, { code: 'slot_unavailable' });
      }
      return reply(200, {
        id: data.id,
        token: issued.token,
        scopes: issued.scopes,
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      // Do not log or echo upstream exceptions, request bodies, or credentials.
      if (error instanceof LocalRuntimeError) {
        if (error.code === 'owner_unavailable') {
          return reply(403, { code: 'forbidden' });
        }
        if (error.code === 'invalid_scope') {
          return reply(400, { code: 'invalid_scope' });
        }
        if (error.code === 'invalid_configuration') {
          return reply(400, { code: 'invalid_request' });
        }
      }
      return reply(500, { code: 'credential_operation_failed' });
    }
  };
}
