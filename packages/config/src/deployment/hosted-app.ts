/**
 * Hosted rendering of the compose deployment contract: turn a declaration
 * resolved at the `deploy` stage into a `HostedApp`
 * (`hosting.happyvertical.com/v1alpha1`) for the platform operator's `smrt`
 * preset. It is the hosted counterpart of `renderSmrtAppChartValues`: both
 * start from the same declaration.
 *
 * The declaration says what the application is. What it may have is the
 * platform's decision, so the caller passes that in as {@link HostedAppEntitlements}
 * (approved bindings, verified domains, volume size) and gets either a
 * manifest or structured rejections that are safe to show a customer. This
 * module is pure: no I/O, no cluster access, browser-safe.
 */

import {
  type ComposeDeploymentDeclaration,
  type ComposeDeploymentIssue,
  validateComposeDeployment,
} from './compose-contract.js';
import { sha256Hex } from './sha256.js';

export const HOSTED_APP_API_VERSION = 'hosting.happyvertical.com/v1alpha1';
export const HOSTED_APP_KIND = 'HostedApp';
export const HOSTED_APP_PRESET = 'smrt';
/** Longest `metadata.name` the operator accepts. */
export const HOSTED_APP_NAME_MAX_LENGTH = 40;

export const HOSTED_APP_TIERS = ['T1', 'T2', 'T3'] as const;
export type HostedAppTier = (typeof HOSTED_APP_TIERS)[number];

export const HOSTED_APP_WORKER_ROLES = [
  'background',
  'schedule',
  'task',
] as const;
export type HostedAppWorkerRole = (typeof HOSTED_APP_WORKER_ROLES)[number];

/** The `HostedApp` fields this module writes. The operator's CRD is the authority. */
export interface HostedAppManifest {
  apiVersion: typeof HOSTED_APP_API_VERSION;
  kind: typeof HOSTED_APP_KIND;
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    poolRef: string;
    tier: HostedAppTier;
    resourceClass?: string;
    release: { id: string; commit?: string };
    domains?: string[];
    preset: {
      name: typeof HOSTED_APP_PRESET;
      images: Record<string, string>;
      parameters: Record<string, string>;
    };
    bindings?: Array<{ name: string; type: string }>;
  };
}

/**
 * A reason a request cannot be honoured. The message is written for the
 * person who owns the compose file and never carries internals or secrets.
 */
export interface HostedAppRejection {
  code: string;
  message: string;
}

/** Where and how the app is hosted. Chosen by the platform, not the declaration. */
export interface HostedAppPlacement {
  /** `metadata.name`: a DNS label of at most {@link HOSTED_APP_NAME_MAX_LENGTH} characters. */
  name: string;
  poolRef: string;
  tier: HostedAppTier;
  resourceClass?: string;
  /** Extra `metadata.labels`, for example the id a collector discovers apps by. */
  labels?: Record<string, string>;
}

/** What this app may have. The caller derives these from its own policy. */
export interface HostedAppEntitlements {
  /** Binding kinds the app may use. A declared binding outside this list is rejected. */
  bindings: readonly string[];
  /** Custom domains verified for the app. A declared domain outside this list is rejected. */
  domains?: readonly string[];
  /**
   * The host the platform derives for the app. A declared domain equal to it
   * is accepted and not written to `spec.domains`, which lists only custom
   * domains.
   */
  platformHost?: string;
  /**
   * Size of every declared volume, a Kubernetes quantity such as `5Gi`. The
   * declaration carries none. Required when the declaration has a volume.
   */
  volumeSize?: string;
}

/** Preset parameters the declaration does not carry but the caller may set. */
export interface HostedAppPresetOptions {
  /** `background` (default), `schedule` or `task`. Applies when there is a worker. */
  workerRole?: HostedAppWorkerRole;
  /** `SMRT_APP_ENVIRONMENT`. */
  environment?: string;
  /** `SMRT_RUNTIME_PROFILE`. */
  runtimeProfile?: string;
}

export interface ComposeHostedAppInput {
  /** The parsed compose document, read at `commit`. Untrusted. */
  document: unknown;
  /** The commit the document was read at, 7 to 64 hex digits. */
  commit: string;
  /**
   * The image digests CI built, by Compose service name
   * (`ghcr.io/acme/app@sha256:...`).
   */
  digests: Record<string, string>;
  app: HostedAppPlacement;
  entitlements: HostedAppEntitlements;
  preset?: HostedAppPresetOptions;
}

export type ComposeHostedAppResult =
  | {
      ok: true;
      manifest: HostedAppManifest;
      declaration: ComposeDeploymentDeclaration;
      warnings: HostedAppRejection[];
    }
  | { ok: false; rejections: HostedAppRejection[] };

const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/;
const DNS_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const QUANTITY = /^[1-9][0-9]*(Ki|Mi|Gi|Ti|k|M|G|T)?$/;
const LABEL_KEY =
  /^([a-z0-9.-]{1,253}\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;

/** Deterministic, so a repeated CI call for the same build is the same release. */
export function hostedAppReleaseId(
  commit: string,
  digests: Record<string, string>,
): string {
  const hash = sha256Hex(
    JSON.stringify(
      Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  ).slice(0, 8);
  return `rel-${commit.slice(0, 12)}-${hash}`;
}

/** Whether `commit` is a spelling {@link composeHostedApp} accepts. */
export function isHostedAppCommit(commit: unknown): commit is string {
  return typeof commit === 'string' && COMMIT_PATTERN.test(commit);
}

function issueToRejection(issue: ComposeDeploymentIssue): HostedAppRejection {
  return { code: issue.code, message: `${issue.message} ${issue.fix}`.trim() };
}

function reject(code: string, message: string): ComposeHostedAppResult {
  return { ok: false, rejections: [{ code, message }] };
}

function labelProblem(labels: unknown): string | undefined {
  if (labels === undefined) return undefined;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    return 'The labels must be an object of strings.';
  }
  for (const [key, value] of Object.entries(labels)) {
    if (
      !LABEL_KEY.test(key) ||
      typeof value !== 'string' ||
      !LABEL_VALUE.test(value)
    ) {
      return 'A label is not a valid Kubernetes label.';
    }
  }
  return undefined;
}

/**
 * Compose the `HostedApp` for one release: validate the declaration at the
 * `deploy` stage, intersect it with the entitlements, and emit the custom
 * resource the operator's `smrt` preset accepts. Never throws on a bad
 * document or bad inputs; every refusal is a rejection.
 */
export function composeHostedApp(
  input: ComposeHostedAppInput,
): ComposeHostedAppResult {
  const { app, entitlements, commit, digests } = input;

  if (!isHostedAppCommit(commit)) {
    return reject('commit-invalid', 'The commit must be 7 to 64 hex digits.');
  }
  if (
    typeof app.name !== 'string' ||
    !DNS_LABEL.test(app.name) ||
    app.name.length > HOSTED_APP_NAME_MAX_LENGTH
  ) {
    return reject(
      'platform-name-invalid',
      `The app name must be a DNS label of at most ${HOSTED_APP_NAME_MAX_LENGTH} characters.`,
    );
  }
  if (!HOSTED_APP_TIERS.includes(app.tier)) {
    return reject(
      'tier-invalid',
      `The tier must be one of: ${HOSTED_APP_TIERS.join(', ')}.`,
    );
  }
  if (typeof app.poolRef !== 'string' || app.poolRef === '') {
    return reject('pool-invalid', 'The app has no pool to run in.');
  }
  const labelIssue = labelProblem(app.labels);
  if (labelIssue) return reject('labels-invalid', labelIssue);
  const workerRole = input.preset?.workerRole;
  if (
    workerRole !== undefined &&
    !HOSTED_APP_WORKER_ROLES.includes(workerRole)
  ) {
    return reject(
      'worker-role-invalid',
      `The worker role must be one of: ${HOSTED_APP_WORKER_ROLES.join(', ')}.`,
    );
  }

  const validated = validateComposeDeployment(input.document, {
    stage: 'deploy',
    images: digests,
  });
  const warnings = validated.warnings.map(issueToRejection);
  if (!validated.ok || !validated.declaration) {
    return { ok: false, rejections: validated.errors.map(issueToRejection) };
  }
  const declaration = validated.declaration;
  const rejections: HostedAppRejection[] = [];

  // The preset knows one web and at most one worker.
  const workers = declaration.workloads.filter(
    (workload) => workload.role === 'worker',
  );
  if (workers.length > 1) {
    rejections.push({
      code: 'multiple-workers-unsupported',
      message: `The hosted preset runs one worker, and this file has ${workers.length} (${workers.map((worker) => worker.name).join(', ')}). Merge them into one worker service.`,
    });
  }

  // Entitlement intersection: every binding the app asks for must be covered.
  const approved = new Set(entitlements.bindings);
  for (const binding of declaration.bindings) {
    if (!approved.has(binding.kind)) {
      rejections.push({
        code: 'binding-not-entitled',
        message: `This app asks for a ${binding.kind} binding, which is not approved for it. Ask the platform operator to approve it or remove it from the compose file.`,
      });
    }
  }

  // Domains: the platform host is derived; any other must be verified.
  const domains: string[] = [];
  if (declaration.domain && declaration.domain !== entitlements.platformHost) {
    if (entitlements.domains?.includes(declaration.domain)) {
      domains.push(declaration.domain);
    } else {
      rejections.push({
        code: 'domain-not-verified',
        message: `The domain ${declaration.domain} has not been verified for this app. Point its DNS at the platform and verify it first.`,
      });
    }
  }

  const hasVolume = declaration.workloads.some(
    (workload) => workload.volumes.length > 0,
  );
  if (hasVolume) {
    if (entitlements.volumeSize === undefined) {
      rejections.push({
        code: 'volume-not-entitled',
        message:
          'This app declares a data volume, but no volume size is approved for it. Ask the platform operator or remove the volume from the compose file.',
      });
    } else if (!QUANTITY.test(entitlements.volumeSize)) {
      rejections.push({
        code: 'volume-size-invalid',
        message:
          'The approved volume size is not a valid quantity such as 5Gi.',
      });
    }
  }

  const images: Record<string, string> = {};
  for (const workload of declaration.workloads) {
    if (workload.image !== undefined) images[workload.role] = workload.image;
  }
  if (!images.web) {
    rejections.push({
      code: 'web-image-missing',
      message: 'The release has no web image digest.',
    });
  }

  // The preset takes one argv per workload and a web health path. It cannot
  // say "run nothing" (Compose `entrypoint: []`/`command: []` discards the
  // image's own command, which an empty argv would silently restore) and it
  // has no web health command, so refuse both rather than drop them.
  for (const workload of declaration.workloads) {
    const declared =
      workload.entrypoint !== undefined || workload.command !== undefined;
    const argv = [...(workload.entrypoint ?? []), ...(workload.command ?? [])];
    if (declared && argv.length === 0) {
      rejections.push({
        code: 'startup-command-unsupported',
        message: `The ${workload.name} service discards its image's command (empty entrypoint/command), which the hosted preset cannot represent. Declare the command to run, or remove the empty entrypoint/command.`,
      });
    }
    if (workload.role === 'web' && 'command' in workload.health) {
      rejections.push({
        code: 'web-health-command-unsupported',
        message: `The ${workload.name} service declares a command health check, but the hosted preset only supports a web health path. Declare health.path instead.`,
      });
    }
  }

  if (rejections.length > 0) return { ok: false, rejections };

  const bindings = declaration.bindings.map((binding) => ({
    name: binding.name,
    type: binding.kind,
  }));
  const manifest: HostedAppManifest = {
    apiVersion: HOSTED_APP_API_VERSION,
    kind: HOSTED_APP_KIND,
    metadata: { name: app.name, labels: { ...(app.labels ?? {}) } },
    spec: {
      poolRef: app.poolRef,
      tier: app.tier,
      ...(app.resourceClass ? { resourceClass: app.resourceClass } : {}),
      release: { id: hostedAppReleaseId(commit, digests), commit },
      ...(domains.length > 0 ? { domains } : {}),
      preset: {
        name: HOSTED_APP_PRESET,
        images,
        parameters: presetParameters(
          declaration,
          entitlements.volumeSize,
          input.preset,
        ),
      },
      ...(bindings.length > 0 ? { bindings } : {}),
    },
  };
  return { ok: true, manifest, declaration, warnings };
}

function presetParameters(
  declaration: ComposeDeploymentDeclaration,
  volumeSize: string | undefined,
  options: HostedAppPresetOptions | undefined,
): Record<string, string> {
  const parameters: Record<string, string> = {
    migrateCommand: JSON.stringify(declaration.migrate.command),
  };
  const migrateRole = declaration.workloads.find(
    (workload) => workload.name === declaration.migrate.service,
  )?.role;
  if (migrateRole === 'worker') parameters.migrateService = 'worker';
  if (options?.workerRole) parameters.workerRole = options.workerRole;
  if (options?.environment) parameters.environment = options.environment;
  if (options?.runtimeProfile) {
    parameters.runtimeProfile = options.runtimeProfile;
  }

  const volumes = new Map<
    string,
    {
      name: string;
      size: string;
      mounts: Array<{ workload: string; path: string; readOnly?: true }>;
    }
  >();
  for (const workload of declaration.workloads) {
    const prefix = workload.role;
    const argv = [...(workload.entrypoint ?? []), ...(workload.command ?? [])];
    // Nothing declared leaves the image's own command to run.
    if (argv.length > 0) parameters[`${prefix}Command`] = JSON.stringify(argv);
    if (workload.role === 'web') {
      if (workload.port !== undefined) {
        parameters.webPort = String(workload.port);
      }
      if ('path' in workload.health) {
        parameters.webHealthPath = workload.health.path;
      }
    } else if ('command' in workload.health) {
      parameters.workerHealthCommand = JSON.stringify(workload.health.command);
    }
    for (const volume of workload.volumes) {
      const entry = volumes.get(volume.name) ?? {
        name: volume.name,
        size: volumeSize as string,
        mounts: [],
      };
      entry.mounts.push({
        workload: workload.role,
        path: volume.target,
        ...(volume.readOnly ? { readOnly: true as const } : {}),
      });
      volumes.set(volume.name, entry);
    }
  }
  if (volumes.size > 0) {
    parameters.volumes = JSON.stringify([...volumes.values()]);
  }
  return parameters;
}
