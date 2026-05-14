export type ContentChatRouteLocals = {
  tenantId?: string | null;
  profileId?: string | null;
  user?: {
    id?: string | null;
  } | null;
};

export function resolveContentChatProfileId(
  locals: ContentChatRouteLocals,
): string | null {
  return locals.profileId || locals.user?.id || null;
}

function getRequestOrigin(request: Request): string | null {
  if (!request.url) return null;
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export function requestHasTrustedOrigin(request: Request): boolean {
  const headers = request.headers;
  if (!headers || typeof headers.get !== 'function') {
    return true;
  }

  const requestOrigin = getRequestOrigin(request);
  if (!requestOrigin) {
    return false;
  }

  const origin = headers.get('origin');
  if (origin) {
    return origin === requestOrigin;
  }

  const secFetchSite = headers.get('sec-fetch-site')?.toLowerCase();
  if (secFetchSite) {
    return (
      secFetchSite === 'same-origin' ||
      secFetchSite === 'same-site' ||
      secFetchSite === 'none'
    );
  }

  const referer = headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin;
    } catch {
      return false;
    }
  }

  return false;
}
