// Which npm registry a release step talks to, and how to make npm actually
// talk to it (#3002).
//
// Releases publish to our own registry first and mirror to npmjs afterwards,
// so an npmjs outage, an expired token, or a hold on the one human account
// that owns the scope there can no longer stop a release (#2998).

export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
export const RELEASE_SCOPE = '@happyvertical';

export function normalizeRegistry(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid registry URL: ${JSON.stringify(url)}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new Error(`Registry URL must be https: ${url}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `Registry URL must not carry credentials, a query, or a fragment: ${parsed.origin}${parsed.pathname}`,
    );
  }
  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
}

// The registry a release is published to and recorded against. Defaults to
// npmjs so a checkout without the variable behaves exactly as it always has.
export function primaryRegistry(env = process.env) {
  return normalizeRegistry(env.RELEASE_PRIMARY_REGISTRY || NPMJS_REGISTRY);
}

// `--registry` alone is NOT enough. This repository's .npmrc maps the
// @happyvertical scope to npmjs, and npm lets a scope mapping override
// --registry for scoped packages: a "publish to our registry" call would
// silently publish to npmjs instead. The scope flag on the command line
// outranks the project .npmrc (a --userconfig file does not), so every npm
// call that names a registry must carry both.
export function registryArgs(registry) {
  const url = normalizeRegistry(registry);
  return ['--registry', url, `--${RELEASE_SCOPE}:registry=${url}`];
}
