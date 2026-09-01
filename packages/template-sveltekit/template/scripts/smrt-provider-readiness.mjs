const PROVIDER_SETTINGS = {
  authentication: 'SMRT_AUTH_READINESS_MODULE',
  assets: 'SMRT_ASSETS_READINESS_MODULE',
  secrets: 'SMRT_SECRETS_READINESS_MODULE',
};

/**
 * Build a provider-owned readiness probe. The installed adapter module must
 * export `checkReadiness()` (or a default function) and return `true` or
 * `{ ready: true }` only after checking its real backing service.
 * @param {'authentication' | 'assets' | 'secrets'} component
 * @param {{profile: string, provider: string}} context
 */
export function createProviderReadinessProbe(component, context) {
  return async () => {
    const setting = PROVIDER_SETTINGS[component];
    const specifier = process.env[setting];
    if (!specifier) {
      throw new Error(
        `${setting} must name an installed provider readiness module.`,
      );
    }
    const module = await import(specifier);
    const probe = module.checkReadiness || module.default;
    if (typeof probe !== 'function') {
      throw new Error(`${setting} does not export a readiness probe.`);
    }
    const result = await probe({ component, ...context });
    if (result !== true && result?.ready !== true) {
      throw new Error(`${component} provider readiness check failed.`);
    }
  };
}
