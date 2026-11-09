/**
 * {@link VaultRelayAdminPort} over the relay's admin HTTP API (private
 * listener, bearer token): `PUT /admin/v1/accounts/:account/devices/:device`,
 * `PUT` and `DELETE /admin/v1/accounts/:account/superseded-by`. The token is
 * sent as a header and never appears in an error, a message or a log.
 */
import { VaultAccountAdminError } from './errors.js';
import type { VaultRelayAdminPort } from './types.js';

export interface VaultRelayAdminClientOptions {
  /** Admin listener origin, e.g. `http://vault-relay-admin:8081`. */
  baseUrl: string;
  /** `VAULT_RELAY_ADMIN_TOKEN`. */
  adminToken: string;
  fetch?: typeof fetch;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function segment(value: string): string {
  if (!SEGMENT.test(value)) {
    throw new VaultAccountAdminError('invalid_request');
  }
  return value;
}

export function createVaultRelayAdminClient(
  options: VaultRelayAdminClientOptions,
): VaultRelayAdminPort {
  if (!options.adminToken || options.adminToken.length < 32) {
    throw new Error('vault relay admin client: the admin token is required');
  }
  const base = new URL(options.baseUrl);
  const token = options.adminToken;
  const doFetch = options.fetch ?? fetch;

  async function call(
    method: 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, string>,
  ): Promise<{ status: number; code: string | null }> {
    const response = await doFetch(new URL(path, base), {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let code: string | null = null;
    if (response.status >= 400) {
      try {
        const parsed = (await response.json()) as { error?: unknown };
        if (
          typeof parsed.error === 'string' &&
          /^\w{1,64}$/.test(parsed.error)
        ) {
          code = parsed.error;
        }
      } catch {
        code = null;
      }
    }
    return { status: response.status, code };
  }

  const fail = (status: number, code: string | null): never => {
    throw new VaultAccountAdminError(
      code ?? `relay_${status}`,
      `The vault relay refused the request (${status}).`,
    );
  };

  return {
    async registerDevice(accountId, deviceId, publicKey) {
      const { status, code } = await call(
        'PUT',
        `/admin/v1/accounts/${segment(accountId)}/devices/${segment(deviceId)}`,
        { publicKey },
      );
      if (status === 201) return 'registered';
      if (status === 200) return 'unchanged';
      if (status === 409) return 'conflict';
      return fail(status, code);
    },
    async supersedeAccount(accountId, supersededBy) {
      const { status, code } = await call(
        'PUT',
        `/admin/v1/accounts/${segment(accountId)}/superseded-by`,
        { supersededBy: segment(supersededBy) },
      );
      if (status === 201) return 'superseded';
      if (status === 200) return 'unchanged';
      return fail(status, code);
    },
    async clearSupersession(accountId) {
      const { status, code } = await call(
        'DELETE',
        `/admin/v1/accounts/${segment(accountId)}/superseded-by`,
      );
      if (status === 204) return true;
      if (status === 404 && code === 'no_supersession') return false;
      return fail(status, code);
    },
  };
}
