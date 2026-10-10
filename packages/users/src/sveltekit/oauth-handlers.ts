/** Fetch/SvelteKit adapters; OAuth protocol handling stays in the SDK. */
import {
  type OAuthAuthorizationServer,
  OAuthServerError,
} from '@happyvertical/auth/server';
import type { SmrtOAuthAuthorizationService } from '../services/OAuthAuthorizationService.js';

/** Structural SvelteKit event, allowing hosts to use their existing session cookie. */
export interface OAuthHandlerEvent {
  request: Request;
  url: URL;
}
/** Hosts supply only their server-side session lookup and consent UI. */
export interface OAuthHandlerOptions<Event extends OAuthHandlerEvent> {
  server: OAuthAuthorizationServer;
  authorization: SmrtOAuthAuthorizationService;
  getSessionId(event: Event): string | null | Promise<string | null>;
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  });
}
function sameOrigin(event: OAuthHandlerEvent) {
  if (event.request.headers.get('origin') !== event.url.origin)
    throw new OAuthServerError(
      'access_denied',
      'Same-origin consent required.',
      403,
    );
}
async function guarded(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OAuthServerError)
      return json(
        { error: error.error, error_description: error.description },
        error.status,
      );
    throw error;
  }
}
/** Helpers for /authorize, consent POST and account grant management; no UI assumptions. */
export function createOAuthHandlers<Event extends OAuthHandlerEvent>(
  options: OAuthHandlerOptions<Event>,
) {
  const session = async (event: Event) => {
    const id = await options.getSessionId(event);
    if (!id)
      throw new OAuthServerError('access_denied', 'Sign in required.', 401);
    return id;
  };
  return {
    /** Return validated scope/client information for the host's consent page. */
    authorize: (event: Event) =>
      guarded(async () => {
        const id = await session(event);
        await options.authorization.listGrants(id); // Prove a live session, not just a cookie.
        return json(
          await options.server.parseAuthorizationRequest(
            event.url.searchParams,
          ),
        );
      }),
    /** A successful POST requires same-origin explicit approval and a fresh session. */
    consent: (event: Event) =>
      guarded(async () => {
        if (event.request.method !== 'POST')
          return new Response(null, { status: 405 });
        sameOrigin(event);
        const id = await session(event);
        const form = await event.request.formData();
        if (form.get('decision') !== 'approve')
          throw new OAuthServerError(
            'access_denied',
            'Authorization denied.',
            403,
          );
        const parsed = await options.server.parseAuthorizationRequest(
          event.url.searchParams,
        );
        const approved = await options.authorization.approve(
          options.server,
          parsed,
          id,
        );
        return new Response(null, {
          status: 303,
          headers: {
            location: approved.redirectUri,
            'cache-control': 'private, no-store',
          },
        });
      }),
    grants: (event: Event) =>
      guarded(async () => {
        if (event.request.method === 'GET')
          return json(
            await options.authorization.listGrants(await session(event)),
          );
        if (event.request.method !== 'POST')
          return new Response(null, { status: 405 });
        sameOrigin(event);
        const id = await session(event);
        const form = await event.request.formData();
        const grantId = form.get('grantId');
        if (typeof grantId !== 'string' || !grantId)
          throw new OAuthServerError('invalid_request', 'grantId is required.');
        return json({
          revoked: await options.authorization.revokeGrant(id, grantId),
        });
      }),
    /** Mount the SDK handler at its configured issuer paths. */
    protocol: (event: Event) => options.server.handle(event.request),
  };
}
