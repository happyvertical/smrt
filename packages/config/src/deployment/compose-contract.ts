/**
 * The compose deployment contract: a Compose file annotated with
 * `x-happyvertical` extension fields is an application's deployment
 * declaration. Compose ignores `x-` keys, so the same file runs locally, on a
 * self-hosted box, and on a platform that reads the annotations.
 *
 * This module validates a parsed Compose document against contract version 1
 * and the supported platform subset, and resolves it into a plain declaration
 * that a platform composer or the `smrt-app` chart renderer consumes. It does
 * no I/O and has no Node dependency: the caller parses the YAML.
 *
 * The published JSON Schema (`schemas/x-happyvertical.v1.schema.json`) covers
 * the shape of the annotations. The rules that span services live here.
 */

/** The Compose extension key the contract lives under. */
export const X_HAPPYVERTICAL_KEY = 'x-happyvertical';

/** The contract version this module validates. */
export const X_HAPPYVERTICAL_VERSION = 1;

/** `$id` of the published JSON Schema for {@link X_HAPPYVERTICAL_VERSION}. */
export const X_HAPPYVERTICAL_SCHEMA_ID =
  'https://s-m-r-t.dev/schemas/x-happyvertical/v1.schema.json';

/** Platform presets a version 1 declaration may name. */
export const X_HAPPYVERTICAL_PRESETS = ['smrt'] as const;

/** Roles a service the application runs may take. */
export const X_HAPPYVERTICAL_ROLES = ['web', 'worker'] as const;

/** Platform services a local container may stand in for. */
export const X_HAPPYVERTICAL_BINDINGS = [
  'postgres',
  'bucket',
  'email',
  'ai',
] as const;

export type XHappyVerticalPreset = (typeof X_HAPPYVERTICAL_PRESETS)[number];
export type XHappyVerticalRole = (typeof X_HAPPYVERTICAL_ROLES)[number];
export type XHappyVerticalBinding = (typeof X_HAPPYVERTICAL_BINDINGS)[number];

/**
 * `declare` checks the file as it sits in the repository: services may be
 * built locally or use tags. `deploy` additionally requires every web and
 * worker service to resolve to an image digest, because the platform deploys
 * what CI already built and never runs `build:`.
 */
export type ComposeDeploymentStage = 'declare' | 'deploy';

export interface ComposeDeploymentOptions {
  /** Defaults to `declare`. */
  stage?: ComposeDeploymentStage;
  /**
   * Image digest references by service name (`registry/name@sha256:…`),
   * normally the digests a release carries. They take precedence over the
   * `image:` written in the file.
   */
  images?: Record<string, string>;
}

export type ComposeDeploymentIssueCode =
  | 'document-invalid'
  | 'not-self-contained'
  | 'contract-missing'
  | 'contract-invalid'
  | 'version-unsupported'
  | 'preset-unknown'
  | 'domain-invalid'
  | 'migrate-missing'
  | 'migrate-invalid'
  | 'migrate-service-not-role'
  | 'services-missing'
  | 'service-invalid'
  | 'service-name-invalid'
  | 'annotation-invalid'
  | 'role-and-binding'
  | 'role-unknown'
  | 'binding-unknown'
  | 'binding-duplicate'
  | 'binding-with-health'
  | 'binding-no-local-image'
  | 'health-missing'
  | 'health-invalid'
  | 'worker-health-needs-command'
  | 'web-service-count'
  | 'ingress-port-count'
  | 'ingress-port-invalid'
  | 'worker-publishes-port'
  | 'service-no-image'
  | 'image-not-digest'
  | 'image-for-unknown-service'
  | 'privileged'
  | 'host-network'
  | 'volume-not-declared'
  | 'volume-not-plain'
  | 'command-not-list'
  | 'interpolated-value'
  | 'merge-key-unresolved'
  | 'local-only-service';

export interface ComposeDeploymentIssue {
  code: ComposeDeploymentIssueCode;
  severity: 'error' | 'warning';
  /** Where in the Compose file the problem is, for example `services.web.ports`. */
  path: string;
  /** The service the issue belongs to, when it belongs to one. */
  service?: string;
  /** What is wrong, in plain language. */
  message: string;
  /** What to change. */
  fix: string;
}

export type ComposeDeploymentHealth = { path: string } | { command: string[] };

export interface ComposeDeploymentVolume {
  /** Name of the volume declared under top-level `volumes:`. */
  name: string;
  /** Path the volume is mounted at inside the container. */
  target: string;
  readOnly: boolean;
}

export interface ComposeDeploymentWorkload {
  name: string;
  role: XHappyVerticalRole;
  /**
   * At the `deploy` stage, always an image digest reference. At the `declare`
   * stage, the `image:` written in the file, absent for a service that is
   * only built locally or whose image is interpolated (contains `$`).
   */
  image?: string;
  /**
   * Present only when the Compose file sets `entrypoint`; an empty list means
   * the image's own entrypoint is ignored. Absent means the image's entrypoint
   * runs, with `command` as its arguments, exactly as Compose does.
   */
  entrypoint?: string[];
  /**
   * Present only when the Compose file sets `command`; an empty list means
   * the image's default command is discarded. Absent means the image's
   * default command runs.
   */
  command?: string[];
  /** The ingress port. Present on the web service only. */
  port?: number;
  health: ComposeDeploymentHealth;
  volumes: ComposeDeploymentVolume[];
}

export interface ComposeDeploymentBinding {
  /** The Compose service name of the local stand-in. */
  name: string;
  kind: XHappyVerticalBinding;
}

export interface ComposeDeploymentMigration {
  /** The web or worker service whose image runs the migration. */
  service: string;
  command: string[];
  /** Same meaning as {@link ComposeDeploymentWorkload.image}. */
  image?: string;
}

/** The resolved declaration. Environment values are deliberately not part of it. */
export interface ComposeDeploymentDeclaration {
  version: typeof X_HAPPYVERTICAL_VERSION;
  preset: XHappyVerticalPreset;
  stage: ComposeDeploymentStage;
  /** Top-level Compose `name:`, when the file sets a literal one (no `$`). */
  name?: string;
  domain?: string;
  migrate: ComposeDeploymentMigration;
  workloads: ComposeDeploymentWorkload[];
  bindings: ComposeDeploymentBinding[];
  /** Services with no annotation. They run locally and are never deployed. */
  localOnly: string[];
}

export interface ComposeDeploymentResult {
  ok: boolean;
  errors: ComposeDeploymentIssue[];
  warnings: ComposeDeploymentIssue[];
  /** Present only when there are no errors. */
  declaration?: ComposeDeploymentDeclaration;
}

type UnknownRecord = Record<string, unknown>;

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const DIGEST_IMAGE = /^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/;
const DOMAIN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const HEALTH_PATH = /^\/\S*$/;
// A string command Compose splits exactly as whitespace does: no quoting,
// escaping, or interpolation that a shell-style split would treat specially.
const PLAIN_COMMAND = /^[A-Za-z0-9_./:=@,+-]+( +[A-Za-z0-9_./:=@,+-]+)*$/;
const INTERPOLATION = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;

const APPLICATION_FIELDS = ['version', 'preset', 'domain', 'migrate'];
const MIGRATE_FIELDS = ['service', 'command'];
const SERVICE_FIELDS = ['role', 'health', 'binding'];
const HEALTH_FIELDS = ['path', 'command'];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

/**
 * Put an arbitrary parsed value into a message without ever throwing: the
 * document is hostile input and may hold objects with no usable `toString`,
 * cycles built from YAML aliases, or values JSON cannot serialize.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return `${value}`;
  }
  if (value === null || value === undefined) return 'an empty value';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'a mapping' : `a ${typeof value}`;
}

/**
 * Compose substitutes `$VAR` and `${VAR}` in every string of the file,
 * extension fields included, before it runs anything. A consumer of the
 * declaration reads the file as written, so a carried string that contains
 * `$` would mean one thing locally and another once deployed.
 */
function refuseVariables(
  values: readonly string[],
  path: string,
  what: string,
  issues: IssueCollector,
  service?: string,
): boolean {
  if (!values.some((value) => value.includes('$'))) return false;
  issues.error(
    'interpolated-value',
    path,
    `${what} contains \`$\`. Compose replaces variables before it runs the stack, but the platform reads the file as written, so the two would not run the same thing.`,
    'Write the literal value. Settings that differ between environments belong in the environment the application reads, not in this line.',
    service,
  );
  return true;
}

/**
 * Path of the first `<<` key anywhere in the document, or undefined. Visits
 * each object once, so cycles built from YAML aliases cannot loop.
 */
function findMergeKey(root: unknown): string | undefined {
  const seen = new Set<object>();
  const pending: Array<[unknown, string]> = [[root, '']];
  while (pending.length > 0) {
    const [value, path] = pending.pop() as [unknown, string];
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        pending.push([item, `${path}[${index}]`]);
      });
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (key === '<<') return here;
      pending.push([item, here]);
    }
  }
  return undefined;
}

/** Compose interpolates this value, so the text in the file is not what runs. */
function isLiteral(value: string): boolean {
  return !value.includes('$');
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}

function unknownFields(value: UnknownRecord, known: string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

class IssueCollector {
  readonly errors: ComposeDeploymentIssue[] = [];
  readonly warnings: ComposeDeploymentIssue[] = [];

  error(
    code: ComposeDeploymentIssueCode,
    path: string,
    message: string,
    fix: string,
    service?: string,
  ): void {
    this.errors.push({
      code,
      severity: 'error',
      path,
      ...(service ? { service } : {}),
      message,
      fix,
    });
  }

  warning(
    code: ComposeDeploymentIssueCode,
    path: string,
    message: string,
    fix: string,
    service?: string,
  ): void {
    this.warnings.push({
      code,
      severity: 'warning',
      path,
      ...(service ? { service } : {}),
      message,
      fix,
    });
  }
}

interface ParsedApplication {
  preset?: XHappyVerticalPreset;
  domain?: string;
  migrateService?: string;
  migrateCommand?: string[];
}

function parseApplication(
  document: UnknownRecord,
  issues: IssueCollector,
): ParsedApplication {
  const path = X_HAPPYVERTICAL_KEY;
  const block = document[X_HAPPYVERTICAL_KEY];
  if (block === undefined) {
    issues.error(
      'contract-missing',
      path,
      `The file has no top-level \`${X_HAPPYVERTICAL_KEY}\` block, so it is an ordinary Compose file and not a deployment declaration.`,
      `Add a top-level \`${X_HAPPYVERTICAL_KEY}\` block with \`version: 1\`, \`preset: smrt\` and a \`migrate\` command.`,
    );
    return {};
  }
  if (!isRecord(block)) {
    issues.error(
      'contract-invalid',
      path,
      `The top-level \`${X_HAPPYVERTICAL_KEY}\` block must be a mapping of fields.`,
      'Write it as indented `key: value` lines: `version`, `preset`, `domain`, `migrate`.',
    );
    return {};
  }

  const parsed: ParsedApplication = {};
  for (const field of unknownFields(block, APPLICATION_FIELDS)) {
    issues.error(
      'contract-invalid',
      `${path}.${field}`,
      `\`${field}\` is not a field of the version 1 contract.`,
      `Remove it or fix the spelling. The top-level fields are ${quoteList(APPLICATION_FIELDS)}.`,
    );
  }

  if (block.version !== X_HAPPYVERTICAL_VERSION) {
    issues.error(
      'version-unsupported',
      `${path}.version`,
      block.version === undefined
        ? 'The contract version is missing.'
        : `Contract version \`${describe(block.version)}\` is not supported here.`,
      'Set `version: 1` (a number, without quotes).',
    );
  }

  if (
    typeof block.preset === 'string' &&
    (X_HAPPYVERTICAL_PRESETS as readonly string[]).includes(block.preset)
  ) {
    parsed.preset = block.preset as XHappyVerticalPreset;
  } else {
    issues.error(
      'preset-unknown',
      `${path}.preset`,
      block.preset === undefined
        ? 'The preset is missing, so the platform does not know what kind of application this is.'
        : `\`${describe(block.preset)}\` is not a preset the platform knows.`,
      `Set \`preset\` to one of: ${quoteList(X_HAPPYVERTICAL_PRESETS)}.`,
    );
  }

  if (block.domain !== undefined) {
    if (
      typeof block.domain === 'string' &&
      block.domain.length <= 253 &&
      DOMAIN.test(block.domain)
    ) {
      parsed.domain = block.domain;
    } else {
      issues.error(
        'domain-invalid',
        `${path}.domain`,
        `\`${describe(block.domain)}\` is not a hostname.`,
        'Write only the hostname in lowercase, for example `app.example.com`: no `https://`, no port, no path.',
      );
    }
  }

  const migrate = block.migrate;
  if (migrate === undefined) {
    issues.error(
      'migrate-missing',
      `${path}.migrate`,
      'There is no `migrate` entry, so the platform does not know how to prepare the database before a release starts.',
      'Add `migrate:` with a `command` list, for example `command: ["pnpm", "exec", "smrt", "db:migrate"]`.',
    );
    return parsed;
  }
  if (!isRecord(migrate)) {
    issues.error(
      'migrate-invalid',
      `${path}.migrate`,
      '`migrate` must be a mapping with a `command`.',
      'Write `migrate:` followed by an indented `command:` list.',
    );
    return parsed;
  }
  for (const field of unknownFields(migrate, MIGRATE_FIELDS)) {
    issues.error(
      'migrate-invalid',
      `${path}.migrate.${field}`,
      `\`${field}\` is not a field of \`migrate\`.`,
      `Remove it or fix the spelling. \`migrate\` takes ${quoteList(MIGRATE_FIELDS)}.`,
    );
  }
  if (isStringList(migrate.command)) {
    if (
      !refuseVariables(
        migrate.command,
        `${path}.migrate.command`,
        'The migration command',
        issues,
      )
    ) {
      parsed.migrateCommand = [...migrate.command];
    }
  } else {
    issues.error(
      'migrate-invalid',
      `${path}.migrate.command`,
      'The migration command must be a list with one argument per item.',
      'Write it as a list, for example `command: ["pnpm", "exec", "smrt", "db:migrate"]`.',
    );
  }
  if (migrate.service !== undefined) {
    if (typeof migrate.service === 'string' && migrate.service.length > 0) {
      parsed.migrateService = migrate.service;
    } else {
      issues.error(
        'migrate-invalid',
        `${path}.migrate.service`,
        '`migrate.service` must be the name of a service in this file.',
        'Name your web or worker service, or remove the line to use the web service.',
      );
    }
  }
  return parsed;
}

function parseHealth(
  name: string,
  role: XHappyVerticalRole,
  health: unknown,
  issues: IssueCollector,
): ComposeDeploymentHealth | undefined {
  const path = `services.${name}.${X_HAPPYVERTICAL_KEY}.health`;
  if (health === undefined) {
    issues.error(
      'health-missing',
      path,
      `Service \`${name}\` has no health check, so the platform cannot tell when it is ready.`,
      role === 'web'
        ? 'Add `health:` with a `path` that answers 200 when the app is ready, for example `path: /api/health`.'
        : 'Add `health:` with a `command` list that exits 0 when the worker is ready.',
      name,
    );
    return undefined;
  }
  if (!isRecord(health)) {
    issues.error(
      'health-invalid',
      path,
      `The health check of \`${name}\` must be a mapping with either \`path\` or \`command\`.`,
      'Write `health:` followed by an indented `path:` or `command:`.',
      name,
    );
    return undefined;
  }
  const extra = unknownFields(health, HEALTH_FIELDS);
  if (extra.length > 0) {
    issues.error(
      'health-invalid',
      `${path}.${extra[0]}`,
      `\`${extra[0]}\` is not a field of a health check.`,
      `Remove it or fix the spelling. A health check takes ${quoteList(HEALTH_FIELDS)}.`,
      name,
    );
    return undefined;
  }
  const hasPath = health.path !== undefined;
  const hasCommand = health.command !== undefined;
  if (hasPath === hasCommand) {
    issues.error(
      'health-invalid',
      path,
      hasPath
        ? `The health check of \`${name}\` has both \`path\` and \`command\`.`
        : `The health check of \`${name}\` is empty.`,
      'Keep exactly one: `path` for an HTTP check, or `command` for a check run inside the container.',
      name,
    );
    return undefined;
  }
  if (hasPath) {
    if (role === 'worker') {
      issues.error(
        'worker-health-needs-command',
        `${path}.path`,
        `Worker \`${name}\` has an HTTP health path, but workers do not serve HTTP.`,
        'Use `command:` with a list that exits 0 when the worker is ready.',
        name,
      );
      return undefined;
    }
    if (typeof health.path !== 'string' || !HEALTH_PATH.test(health.path)) {
      issues.error(
        'health-invalid',
        `${path}.path`,
        `The health path of \`${name}\` must start with \`/\` and contain no spaces.`,
        'Write a path such as `/api/health`.',
        name,
      );
      return undefined;
    }
    if (
      refuseVariables(
        [health.path],
        `${path}.path`,
        `The health path of \`${name}\``,
        issues,
        name,
      )
    ) {
      return undefined;
    }
    return { path: health.path };
  }
  if (!isStringList(health.command)) {
    issues.error(
      'health-invalid',
      `${path}.command`,
      `The health command of \`${name}\` must be a list with one argument per item.`,
      'Write it as a list, for example `command: ["pnpm", "exec", "smrt", "app", "doctor"]`.',
      name,
    );
    return undefined;
  }
  if (
    refuseVariables(
      health.command,
      `${path}.command`,
      `The health command of \`${name}\``,
      issues,
      name,
    )
  ) {
    return undefined;
  }
  return { command: [...health.command] };
}

function parseCommand(
  name: string,
  field: 'command' | 'entrypoint',
  value: unknown,
  issues: IssueCollector,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  // Empty is meaningful in Compose, for both fields: `[]` or '' discards what
  // the image declares, and only a missing or null value inherits it.
  const empty =
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'string' && value.trim() === '');
  if (empty) return [];
  const path = `services.${name}.${field}`;
  const what = `The \`${field}\` of \`${name}\``;
  if (isStringList(value)) {
    return refuseVariables(value, path, what, issues, name)
      ? undefined
      : [...value];
  }
  if (typeof value === 'string') {
    if (refuseVariables([value], path, what, issues, name)) return undefined;
    if (PLAIN_COMMAND.test(value.trim())) return value.trim().split(/ +/);
  }
  issues.error(
    'command-not-list',
    `services.${name}.${field}`,
    `The \`${field}\` of \`${name}\` uses quoting or shell syntax, or is not text, which Compose and the platform would read differently.`,
    `Write \`${field}\` as a list with one argument per item, for example \`["node", "build"]\`.`,
    name,
  );
  return undefined;
}

interface PortScan {
  ports: number[];
  invalid: boolean;
}

function scanPortEntry(
  name: string,
  field: 'ports' | 'expose',
  entry: unknown,
  index: number,
  issues: IssueCollector,
): number | undefined {
  const path = `services.${name}.${field}[${index}]`;
  const invalid = (reason: string): undefined => {
    issues.error(
      'ingress-port-invalid',
      path,
      `Port entry \`${describe(entry)}\` of \`${name}\` ${reason}.`,
      'Publish one fixed TCP port, for example `"3000:3000"`.',
      name,
    );
    return undefined;
  };

  if (typeof entry === 'number') {
    return Number.isInteger(entry) && entry > 0 && entry < 65536
      ? entry
      : invalid('is not a valid port number');
  }
  if (typeof entry === 'string') {
    // A published side may be interpolated (`${WEB_PORT:-3000}:3000`); only
    // the container side has to be a literal the platform can read.
    const withoutVariables = entry.replace(INTERPOLATION, '\u0000');
    const [address, protocol] = withoutVariables.split('/');
    if (protocol !== undefined && protocol.toLowerCase() !== 'tcp') {
      return invalid('is not TCP');
    }
    const container = address.split(':').at(-1) ?? '';
    if (!/^\d+$/.test(container)) {
      return invalid(
        container.includes('-')
          ? 'is a port range'
          : 'does not name a fixed container port',
      );
    }
    const port = Number(container);
    return port > 0 && port < 65536
      ? port
      : invalid('is not a valid port number');
  }
  if (isRecord(entry)) {
    if (entry.mode !== undefined && entry.mode !== 'ingress') {
      issues.error(
        'host-network',
        path,
        `Service \`${name}\` publishes a port in \`${describe(entry.mode)}\` mode, which binds it to the network of the machine it runs on.`,
        'Remove the `mode` line. The platform routes traffic to the container for you.',
        name,
      );
      return undefined;
    }
    if (
      entry.protocol !== undefined &&
      !(
        typeof entry.protocol === 'string' &&
        entry.protocol.toLowerCase() === 'tcp'
      )
    ) {
      return invalid('is not TCP');
    }
    const target =
      typeof entry.target === 'number'
        ? entry.target
        : typeof entry.target === 'string' && /^\d+$/.test(entry.target)
          ? Number(entry.target)
          : Number.NaN;
    return Number.isInteger(target) && target > 0 && target < 65536
      ? target
      : invalid('does not name a fixed container port in `target`');
  }
  return invalid('is not a port');
}

function scanPorts(
  name: string,
  field: 'ports' | 'expose',
  value: unknown,
  issues: IssueCollector,
): PortScan {
  if (value === undefined || value === null) {
    return { ports: [], invalid: false };
  }
  if (!Array.isArray(value)) {
    issues.error(
      'ingress-port-invalid',
      `services.${name}.${field}`,
      `\`${field}\` of \`${name}\` must be a list.`,
      'Publish one fixed TCP port, for example `ports: ["3000:3000"]`.',
      name,
    );
    return { ports: [], invalid: true };
  }
  const before = issues.errors.length;
  const ports = new Set<number>();
  value.forEach((entry, index) => {
    const port = scanPortEntry(name, field, entry, index, issues);
    if (port !== undefined) ports.add(port);
  });
  return { ports: [...ports], invalid: issues.errors.length > before };
}

function isHostPath(source: string): boolean {
  return (
    source.startsWith('.') ||
    source.startsWith('/') ||
    source.startsWith('~') ||
    source.includes('$') ||
    source.includes('\\') ||
    /^[A-Za-z]:/.test(source)
  );
}

function scanVolumes(
  name: string,
  service: UnknownRecord,
  declared: UnknownRecord,
  issues: IssueCollector,
): ComposeDeploymentVolume[] {
  const volumes: ComposeDeploymentVolume[] = [];
  const notDeclared = (path: string, what: string): void => {
    issues.error(
      'volume-not-declared',
      path,
      `Service \`${name}\` ${what}. The platform only keeps data in volumes the file declares.`,
      'Declare a named volume under top-level `volumes:` and mount it as `name:/path/in/container`. Files the app needs belong in its image.',
      name,
    );
  };
  const useNamed = (
    path: string,
    source: string,
    target: string,
    readOnly: boolean,
  ): void => {
    if (!Object.hasOwn(declared, source)) {
      notDeclared(
        path,
        `mounts the volume \`${source}\`, which is not declared in this file`,
      );
      return;
    }
    const definition = declared[source];
    if (isRecord(definition)) {
      const external =
        definition.external !== undefined && definition.external !== false;
      const customDriver =
        definition.driver !== undefined && definition.driver !== 'local';
      if (external || customDriver || definition.driver_opts !== undefined) {
        issues.error(
          'volume-not-plain',
          `volumes.${source}`,
          `Volume \`${source}\` is external or uses driver options, so its contents live somewhere this file does not describe.`,
          'Declare it as a plain named volume (just `name:` with nothing under it).',
          name,
        );
        return;
      }
    }
    if (
      refuseVariables(
        [target],
        path,
        `The mount path of volume \`${source}\` in \`${name}\``,
        issues,
        name,
      )
    ) {
      return;
    }
    volumes.push({ name: source, target, readOnly });
  };

  if (
    Array.isArray(service.volumes_from)
      ? service.volumes_from.length > 0
      : service.volumes_from !== undefined && service.volumes_from !== null
  ) {
    notDeclared(
      `services.${name}.volumes_from`,
      "borrows another container's volumes with `volumes_from`",
    );
  }

  const entries = service.volumes;
  if (entries === undefined || entries === null) return volumes;
  if (!Array.isArray(entries)) {
    notDeclared(
      `services.${name}.volumes`,
      'has a `volumes` entry that is not a list',
    );
    return volumes;
  }
  entries.forEach((entry, index) => {
    const path = `services.${name}.volumes[${index}]`;
    if (typeof entry === 'string') {
      // A drive letter or a backslash is a Windows host path; splitting it
      // on `:` would mistake the drive letter for a volume name.
      if (/^[A-Za-z]:[\\/]/.test(entry) || entry.includes('\\')) {
        notDeclared(
          path,
          `mounts \`${describe(entry)}\` from the machine it runs on (a bind mount)`,
        );
        return;
      }
      const [source, target, mode] = entry.split(':');
      if (target === undefined) {
        notDeclared(path, `mounts an unnamed volume at \`${entry}\``);
      } else if (isHostPath(source)) {
        notDeclared(
          path,
          `mounts \`${source}\` from the machine it runs on (a bind mount)`,
        );
      } else {
        useNamed(path, source, target, (mode ?? '').split(',').includes('ro'));
      }
      return;
    }
    if (isRecord(entry)) {
      const type = entry.type ?? 'volume';
      if (type === 'tmpfs') return;
      if (type !== 'volume') {
        notDeclared(
          path,
          `uses a \`${describe(type)}\` mount, which reads from the machine it runs on`,
        );
        return;
      }
      if (typeof entry.source !== 'string' || entry.source.length === 0) {
        notDeclared(path, 'mounts an unnamed volume');
        return;
      }
      if (typeof entry.target !== 'string' || entry.target.length === 0) {
        notDeclared(path, 'has a volume entry with no `target` path');
        return;
      }
      useNamed(
        path,
        entry.source,
        entry.target,
        entry.read_only !== undefined && entry.read_only !== false,
      );
      return;
    }
    notDeclared(path, 'has a volume entry that is not a mount');
  });
  return volumes;
}

interface RoleService {
  name: string;
  role: XHappyVerticalRole;
  definition: UnknownRecord;
  health?: ComposeDeploymentHealth;
}

function resolveImage(
  entry: RoleService,
  options: ComposeDeploymentOptions,
  stage: ComposeDeploymentStage,
  issues: IssueCollector,
): string | undefined {
  const { name, definition } = entry;
  const declared =
    typeof definition.image === 'string' && definition.image.length > 0
      ? definition.image
      : undefined;
  const hasBuild = definition.build !== undefined && definition.build !== null;
  // Own keys only: a service may be called `constructor` or `toString`.
  const supplied =
    options.images && Object.hasOwn(options.images, name)
      ? options.images[name]
      : undefined;

  if (declared === undefined && !hasBuild) {
    issues.error(
      'service-no-image',
      `services.${name}`,
      `Service \`${name}\` has neither \`image\` nor \`build\`, so nothing can run it.`,
      'Add `build: .` to build it locally, or `image:` with the image to run.',
      name,
    );
  }
  if (stage === 'declare') {
    // Informational at this stage: carry the image only as literal text.
    const image = supplied ?? declared;
    return image !== undefined && isLiteral(image) ? image : undefined;
  }

  const effective = supplied ?? declared;
  if (effective !== undefined && DIGEST_IMAGE.test(effective)) {
    return effective;
  }
  issues.error(
    'image-not-digest',
    `services.${name}.image`,
    effective === undefined
      ? `Service \`${name}\` is only built locally. The platform deploys an image that CI already built and pushed; it never runs \`build:\`.`
      : `The image of \`${name}\` (\`${effective}\`) is a tag, which can change after it was tested. The platform deploys exact image digests only.`,
    `Supply the digest CI pushed for \`${name}\`, in the form \`registry/name@sha256:\` followed by 64 hex characters.`,
    name,
  );
  return undefined;
}

function checkRoleService(
  entry: RoleService,
  declaredVolumes: UnknownRecord,
  options: ComposeDeploymentOptions,
  stage: ComposeDeploymentStage,
  issues: IssueCollector,
): ComposeDeploymentWorkload | undefined {
  const { name, role, definition } = entry;
  const before = issues.errors.length;

  if (definition.extends !== undefined) {
    issues.error(
      'not-self-contained',
      `services.${name}.extends`,
      `Service \`${name}\` takes part of its definition from another service with \`extends\`, so what it runs is not written here.`,
      'Write the service out in full. The platform reads each service as written, in this one file.',
      name,
    );
  }

  const image = resolveImage(entry, options, stage, issues);

  // Fail closed: Compose reads YAML 1.1 booleans (`yes`, `on`), which a
  // YAML 1.2 parser hands over as strings. Anything but an explicit false is
  // treated as a request for privileged mode.
  if (
    definition.privileged !== undefined &&
    definition.privileged !== null &&
    definition.privileged !== false
  ) {
    issues.error(
      'privileged',
      `services.${name}.privileged`,
      `Service \`${name}\` sets \`privileged\`. Privileged mode gives a container control of the machine it runs on, and Compose accepts more spellings of "yes" than can be told apart here.`,
      'Remove the `privileged` line. The platform never runs privileged containers.',
      name,
    );
  }

  if (definition.network_mode === 'host') {
    issues.error(
      'host-network',
      `services.${name}.network_mode`,
      `Service \`${name}\` uses the host's network instead of its own.`,
      'Remove `network_mode: host`. Services reach each other by service name, and the platform routes outside traffic to the web service.',
      name,
    );
  }

  const volumes = scanVolumes(name, definition, declaredVolumes, issues);
  const entrypoint = parseCommand(
    name,
    'entrypoint',
    definition.entrypoint,
    issues,
  );
  const command = parseCommand(name, 'command', definition.command, issues);

  let port: number | undefined;
  const publishesNothing =
    definition.ports === undefined ||
    definition.ports === null ||
    (Array.isArray(definition.ports) && definition.ports.length === 0);
  const published =
    role === 'web'
      ? scanPorts(name, 'ports', definition.ports, issues)
      : { ports: [], invalid: false };
  if (role === 'web') {
    const exposed =
      published.ports.length === 0 && !published.invalid
        ? scanPorts(name, 'expose', definition.expose, issues)
        : { ports: [], invalid: false };
    const ports = published.ports.length > 0 ? published.ports : exposed.ports;
    if (!published.invalid && !exposed.invalid && ports.length !== 1) {
      issues.error(
        'ingress-port-count',
        `services.${name}.ports`,
        ports.length === 0
          ? `Web service \`${name}\` publishes no port, so there is nothing to send visitors to.`
          : `Web service \`${name}\` publishes ${ports.length} ports (${ports.join(', ')}). The platform routes visitors to exactly one.`,
        'Publish exactly one port, the one the app listens on, for example `ports: ["3000:3000"]`.',
        name,
      );
    }
    port = ports[0];
  } else if (!publishesNothing) {
    issues.error(
      'worker-publishes-port',
      `services.${name}.ports`,
      `Worker \`${name}\` publishes a port, but only the web service receives traffic.`,
      'Remove `ports` from the worker, or give the service `role: web` if it is the one visitors reach.',
      name,
    );
  }

  if (issues.errors.length > before || entry.health === undefined) {
    return undefined;
  }
  return {
    name,
    role,
    ...(image !== undefined ? { image } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(command ? { command } : {}),
    ...(port !== undefined ? { port } : {}),
    health: entry.health,
    volumes,
  };
}

/**
 * Validate a parsed Compose document as a deployment declaration.
 *
 * Errors are things the platform refuses. Warnings never block: they report
 * services that only run locally. `declaration` is present when there are no
 * errors.
 */
export function validateComposeDeployment(
  document: unknown,
  options: ComposeDeploymentOptions = {},
): ComposeDeploymentResult {
  const issues = new IssueCollector();
  const stage = options.stage ?? 'declare';
  const finish = (
    declaration?: ComposeDeploymentDeclaration,
  ): ComposeDeploymentResult => ({
    ok: issues.errors.length === 0,
    errors: issues.errors,
    warnings: issues.warnings,
    ...(issues.errors.length === 0 && declaration ? { declaration } : {}),
  });

  if (!isRecord(document)) {
    issues.error(
      'document-invalid',
      '',
      'This is not a Compose file: the top level must be a mapping with `services`.',
      'Check that the file is valid YAML and starts with top-level keys such as `services:`.',
    );
    return finish();
  }

  // A `<<` key anywhere means the caller parsed without YAML merge keys, so
  // some mapping is missing whatever its anchor carries: a port's protocol, a
  // volume's driver, a whole service. Nothing below can be trusted, so stop.
  const mergeKey = findMergeKey(document);
  if (mergeKey !== undefined) {
    issues.error(
      'merge-key-unresolved',
      mergeKey,
      'The file still contains a YAML merge key (`<<`), so the part of it that comes from an anchor was not read.',
      'Parse the file with YAML merge keys enabled, as Compose does (`smrt deploy:check` does this for you).',
    );
    return finish();
  }

  if (document.include !== undefined) {
    issues.error(
      'not-self-contained',
      'include',
      'The file pulls in other Compose files with `include`.',
      'Put every service in this one file. The platform reads this file and nothing else.',
    );
  }

  const application = parseApplication(document, issues);

  const services = document.services;
  if (!isRecord(services) || Object.keys(services).length === 0) {
    issues.error(
      'services-missing',
      'services',
      'The file declares no services.',
      'Add your application under `services:`, with at least a web service.',
    );
    return finish();
  }
  const declaredVolumes = isRecord(document.volumes) ? document.volumes : {};

  const roleServices: RoleService[] = [];
  const bindings: ComposeDeploymentBinding[] = [];
  const localOnly: string[] = [];

  for (const [name, definition] of Object.entries(services)) {
    if (!isRecord(definition)) {
      issues.error(
        'service-invalid',
        `services.${name}`,
        `Service \`${name}\` is empty or not a mapping.`,
        'Give it an `image` or `build` and the settings it needs, or remove it.',
        name,
      );
      continue;
    }
    const annotationPath = `services.${name}.${X_HAPPYVERTICAL_KEY}`;
    const annotation = definition[X_HAPPYVERTICAL_KEY];
    if (annotation === undefined) {
      localOnly.push(name);
      continue;
    }
    if (!isRecord(annotation)) {
      issues.error(
        'annotation-invalid',
        annotationPath,
        `The \`${X_HAPPYVERTICAL_KEY}\` block of \`${name}\` must be a mapping.`,
        'Write `role: web` or `role: worker` with a `health` check, or `binding:` with the platform service it stands in for.',
        name,
      );
      continue;
    }
    const extra = unknownFields(annotation, SERVICE_FIELDS);
    if (extra.length > 0) {
      issues.error(
        'annotation-invalid',
        `${annotationPath}.${extra[0]}`,
        `\`${extra[0]}\` is not a field of a service annotation.`,
        `Remove it or fix the spelling. A service takes ${quoteList(SERVICE_FIELDS)}.`,
        name,
      );
      continue;
    }
    const hasRole = annotation.role !== undefined;
    const hasBinding = annotation.binding !== undefined;
    if (hasRole && hasBinding) {
      issues.error(
        'role-and-binding',
        annotationPath,
        `Service \`${name}\` has both \`role\` and \`binding\`. A service is either part of your application or a stand-in for a platform service.`,
        'Keep `role` for something you build and run, or `binding` for something the platform provides.',
        name,
      );
      continue;
    }
    if (!hasRole && !hasBinding) {
      issues.error(
        'annotation-invalid',
        annotationPath,
        `The \`${X_HAPPYVERTICAL_KEY}\` block of \`${name}\` says neither what the service is nor what it stands in for.`,
        'Add `role: web`, `role: worker`, or `binding:`. Remove the block if the service is only for local use.',
        name,
      );
      continue;
    }
    if (!SERVICE_NAME.test(name)) {
      issues.error(
        'service-name-invalid',
        `services.${name}`,
        `The service name \`${name}\` cannot be used as a platform resource name.`,
        'Rename it using lowercase letters, digits and hyphens, starting with a letter, at most 31 characters.',
        name,
      );
    }

    if (hasBinding) {
      const kind = annotation.binding;
      if (
        typeof kind !== 'string' ||
        !(X_HAPPYVERTICAL_BINDINGS as readonly string[]).includes(kind)
      ) {
        issues.error(
          'binding-unknown',
          `${annotationPath}.binding`,
          `\`${describe(kind)}\` is not a platform service this contract knows.`,
          `Set \`binding\` to one of: ${quoteList(X_HAPPYVERTICAL_BINDINGS)}.`,
          name,
        );
        continue;
      }
      if (annotation.health !== undefined) {
        issues.error(
          'binding-with-health',
          `${annotationPath}.health`,
          `Binding \`${name}\` has a \`health\` check, but the platform runs its own service in place of this container.`,
          'Remove `health` from the annotation. A Compose `healthcheck:` on the service is fine for local use.',
          name,
        );
      }
      const hasImage =
        typeof definition.image === 'string' && definition.image.length > 0;
      const hasBuild =
        definition.build !== undefined && definition.build !== null;
      if (!hasImage && !hasBuild) {
        issues.error(
          'binding-no-local-image',
          `services.${name}.image`,
          `Binding \`${name}\` has no local image, so the stack cannot run anywhere the platform is not providing ${kind}.`,
          'Add the image you run locally, for example `image: postgres:18-alpine`, so the file stays a complete working stack on its own.',
          name,
        );
      }
      const duplicate = bindings.find((binding) => binding.kind === kind);
      if (duplicate) {
        issues.error(
          'binding-duplicate',
          `${annotationPath}.binding`,
          `Services \`${duplicate.name}\` and \`${name}\` both stand in for \`${kind}\`. Version 1 binds each platform service once.`,
          `Keep one \`${kind}\` binding.`,
          name,
        );
        continue;
      }
      bindings.push({ name, kind: kind as XHappyVerticalBinding });
      continue;
    }

    const role = annotation.role;
    if (
      typeof role !== 'string' ||
      !(X_HAPPYVERTICAL_ROLES as readonly string[]).includes(role)
    ) {
      issues.error(
        'role-unknown',
        `${annotationPath}.role`,
        `\`${describe(role)}\` is not a role.`,
        `Set \`role\` to one of: ${quoteList(X_HAPPYVERTICAL_ROLES)}.`,
        name,
      );
      continue;
    }
    roleServices.push({
      name,
      role: role as XHappyVerticalRole,
      definition,
      health: parseHealth(
        name,
        role as XHappyVerticalRole,
        annotation.health,
        issues,
      ),
    });
  }

  const webServices = roleServices.filter((entry) => entry.role === 'web');
  if (webServices.length !== 1) {
    issues.error(
      'web-service-count',
      'services',
      webServices.length === 0
        ? 'No service has `role: web`, so there is nothing for visitors to reach.'
        : `${webServices.length} services have \`role: web\` (${quoteList(webServices.map((entry) => entry.name))}). The platform routes visitors to exactly one.`,
      'Give exactly one service `role: web`. Anything else you run is `role: worker`.',
    );
  }

  const workloads: ComposeDeploymentWorkload[] = [];
  for (const entry of roleServices) {
    const workload = checkRoleService(
      entry,
      declaredVolumes,
      options,
      stage,
      issues,
    );
    if (workload) workloads.push(workload);
  }

  for (const name of Object.keys(options.images ?? {})) {
    if (!roleServices.some((entry) => entry.name === name)) {
      issues.error(
        'image-for-unknown-service',
        `services.${name}`,
        `An image digest was supplied for \`${name}\`, which is not a web or worker service in this file.`,
        `Supply digests only for: ${quoteList(roleServices.map((entry) => entry.name))}.`,
        name,
      );
    }
  }

  const migrateService = application.migrateService ?? webServices[0]?.name;
  if (
    application.migrateService !== undefined &&
    !roleServices.some((entry) => entry.name === application.migrateService)
  ) {
    issues.error(
      'migrate-service-not-role',
      `${X_HAPPYVERTICAL_KEY}.migrate.service`,
      `\`migrate.service\` names \`${application.migrateService}\`, which is not a web or worker service in this file. The migration ships inside one of your application images.`,
      `Name one of: ${quoteList(roleServices.map((entry) => entry.name))}, or remove the line to use the web service.`,
    );
  }

  for (const name of localOnly) {
    issues.warning(
      'local-only-service',
      `services.${name}`,
      `Service \`${name}\` has no \`${X_HAPPYVERTICAL_KEY}\` annotation. It runs on your machine only; the platform will not run it.`,
      'Nothing to do if that is intended. Otherwise give it `role: web`, `role: worker` or a `binding`.',
      name,
    );
  }

  if (
    issues.errors.length > 0 ||
    application.preset === undefined ||
    application.migrateCommand === undefined ||
    migrateService === undefined
  ) {
    return finish();
  }

  const migrateImage = workloads.find(
    (workload) => workload.name === migrateService,
  )?.image;
  return finish({
    version: X_HAPPYVERTICAL_VERSION,
    preset: application.preset,
    stage,
    ...(typeof document.name === 'string' &&
    document.name.length > 0 &&
    isLiteral(document.name)
      ? { name: document.name }
      : {}),
    ...(application.domain !== undefined ? { domain: application.domain } : {}),
    migrate: {
      service: migrateService,
      command: application.migrateCommand,
      ...(migrateImage !== undefined ? { image: migrateImage } : {}),
    },
    workloads,
    bindings,
    localOnly,
  });
}

function formatIssue(issue: ComposeDeploymentIssue, index: number): string {
  const where = issue.path ? `${issue.path}: ` : '';
  return `${index + 1}. ${where}${issue.message}\n   Fix: ${issue.fix}`;
}

/** Render a validation result as plain text for a terminal or a log. */
export function formatComposeDeploymentReport(
  result: ComposeDeploymentResult,
): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push('The deployment declaration is valid.');
    const declaration = result.declaration;
    if (declaration) {
      const describe = (workload: ComposeDeploymentWorkload): string =>
        workload.port !== undefined
          ? `${workload.name} (${workload.role}, port ${workload.port})`
          : `${workload.name} (${workload.role})`;
      lines.push(
        `Preset: ${declaration.preset}`,
        `Runs: ${declaration.workloads.map(describe).join(', ')}`,
        `Migration: ${declaration.migrate.command.join(' ')} (in the ${declaration.migrate.service} image)`,
        `Platform services: ${
          declaration.bindings.length > 0
            ? declaration.bindings
                .map((binding) => `${binding.kind} (local: ${binding.name})`)
                .join(', ')
            : 'none'
        }`,
      );
      if (declaration.domain) lines.push(`Domain: ${declaration.domain}`);
    }
  } else {
    const count = result.errors.length;
    lines.push(
      `The deployment declaration has ${count} problem${count === 1 ? '' : 's'}.`,
      '',
      ...result.errors.map(formatIssue),
    );
  }
  if (result.warnings.length > 0) {
    lines.push(
      '',
      `Runs only on your machine (the platform will not run it): ${result.warnings
        .map((warning) => warning.service ?? warning.path)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}
