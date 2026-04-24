const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'apikey',
  'api_key',
  'auth',
  'auth_token',
  'password',
  'token',
]);

type MaybeCloseableDatabase = {
  close?: () => unknown | Promise<unknown>;
  client?: {
    close?: () => unknown | Promise<unknown>;
    end?: () => unknown | Promise<unknown>;
  };
};

export function redactConnectionString(value: string): string {
  let redacted = value;

  try {
    const url = new URL(value);

    if (url.password) {
      url.password = '***';
    }

    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, '***');
      }
    }

    redacted = url.toString();
  } catch {
    redacted = value.replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi,
      '$1***$2',
    );
  }

  return redacted.replace(
    /([?&](?:access_token|apikey|api_key|auth|auth_token|password|token)=)[^&\s]+/gi,
    '$1***',
  );
}

export function formatDatabaseDisplayUrl(
  dbType: string,
  dbUrl: string,
): string {
  const displayUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(dbUrl)
    ? dbUrl
    : `${dbType}://${dbUrl}`;

  return redactConnectionString(displayUrl);
}

export async function closeDatabaseConnection(db: unknown): Promise<void> {
  if (!db || typeof db !== 'object') {
    return;
  }

  const closeable = db as MaybeCloseableDatabase;
  const close =
    closeable.close ?? closeable.client?.end ?? closeable.client?.close;

  if (typeof close !== 'function') {
    return;
  }

  try {
    await close.call(closeable.close ? closeable : closeable.client);
  } catch {
    // Diagnostics should not fail after the command already produced output.
  }
}
