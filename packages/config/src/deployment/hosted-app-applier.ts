/**
 * Server-side apply of a `HostedApp`. This is the one write path from a
 * deployer to the cluster: one custom resource kind, one credential whose
 * RBAC is what bounds it. The client cannot name another resource.
 *
 * Errors carry the HTTP status only: never the token, the request or the
 * response body.
 */

import {
  HOSTED_APP_API_VERSION,
  HOSTED_APP_KIND,
  type HostedAppManifest,
} from './hosted-app.js';

export interface HostedAppApplier {
  /** Create or update the HostedApp; resolves with the resulting `metadata.generation`. */
  apply(manifest: HostedAppManifest): Promise<{ generation: number }>;
  /** Delete the HostedApp by name. The operator enforces retention on the data. A missing one is not an error. */
  remove(name: string): Promise<void>;
}

export class HostedAppApplyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HostedAppApplyError';
  }
}

export interface HostedAppApplierOptions {
  /** The Kubernetes API server origin, for example `https://k8s.example:6443`. */
  apiServer: string;
  /** A bearer token scoped to the HostedApp kind. Never logged or echoed. */
  token: string;
  fetch?: typeof fetch;
  /** Defaults to `smrt-hosting`. */
  fieldManager?: string;
}

const COLLECTION = 'apis/hosting.happyvertical.com/v1alpha1/hostedapps';
const NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

export function createHostedAppApplier(
  options: HostedAppApplierOptions,
): HostedAppApplier {
  const doFetch = options.fetch ?? fetch;
  let base: string;
  try {
    const url = new URL(options.apiServer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error();
    base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    throw new HostedAppApplyError(0, 'The API server is not a valid URL.');
  }
  if (typeof options.token !== 'string' || options.token === '') {
    throw new HostedAppApplyError(0, 'A token is required.');
  }
  const headers = { authorization: `Bearer ${options.token}` };
  const checkName = (name: unknown): string => {
    if (typeof name !== 'string' || !NAME.test(name) || name.length > 63) {
      throw new HostedAppApplyError(0, 'The app name is not a DNS label.');
    }
    return name;
  };

  return {
    async apply(manifest) {
      if (
        manifest.apiVersion !== HOSTED_APP_API_VERSION ||
        manifest.kind !== HOSTED_APP_KIND
      ) {
        throw new HostedAppApplyError(0, 'Only a HostedApp can be applied.');
      }
      const name = checkName(manifest.metadata?.name);
      const manager = encodeURIComponent(
        options.fieldManager ?? 'smrt-hosting',
      );
      const response = await doFetch(
        `${base}/${COLLECTION}/${encodeURIComponent(name)}?fieldManager=${manager}&force=true`,
        {
          method: 'PATCH',
          headers: {
            ...headers,
            'content-type': 'application/apply-patch+yaml',
          },
          body: JSON.stringify(manifest),
        },
      );
      if (!response.ok) {
        throw new HostedAppApplyError(
          response.status,
          `apply failed (${response.status})`,
        );
      }
      const body = (await response.json()) as {
        metadata?: { generation?: number };
      };
      return { generation: body.metadata?.generation ?? 0 };
    },
    async remove(name) {
      const response = await doFetch(
        `${base}/${COLLECTION}/${encodeURIComponent(checkName(name))}`,
        { method: 'DELETE', headers },
      );
      if (!response.ok && response.status !== 404) {
        throw new HostedAppApplyError(
          response.status,
          `delete failed (${response.status})`,
        );
      }
    },
  };
}
