const AGENT_PLUGIN_SCHEMAS = 'https://agent-plugins.org/schemas/1.0.0';
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const PORTABLE_SEGMENT = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

export interface DesktopPluginLauncher {
  /** Platform of the packaged executable. */
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** Executable the desktop packager supplies under server/ in each package. */
  readonly executable: string;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Desktop plugin ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function optionalObject(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = field(record, key);
  return value === undefined ? {} : object(value, label);
}

function publicText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`Desktop plugin ${label} must be non-empty plain text`);
  }
  return value.trim();
}

function resolveLauncher(executable: unknown): string {
  if (
    typeof executable !== 'string' ||
    !executable.startsWith('server/') ||
    executable
      .split('/')
      .some(
        (segment) =>
          !PORTABLE_SEGMENT.test(segment) || WINDOWS_DEVICE.test(segment),
      )
  ) {
    throw new Error(
      'Desktop plugin launcher must be a portable path under server/',
    );
  }
  return executable;
}

/**
 * Render manifest and marketplace files relative to a new distribution root.
 * The input is public product metadata in the portable Agent Plugins shape.
 * The packager supplies the launcher separately for its target platform.
 */
export function generateDesktopPluginArtifacts(
  productManifest: unknown,
  launcher: DesktopPluginLauncher,
): Readonly<Record<string, string>> {
  const manifest = object(productManifest, 'product manifest');
  const name = publicText(field(manifest, 'name'), 'name');
  if (
    name.length > 64 ||
    !PLUGIN_NAME.test(name) ||
    WINDOWS_DEVICE.test(name)
  ) {
    throw new Error('Desktop plugin name must be a portable lowercase slug');
  }
  const version = publicText(field(manifest, 'version'), 'version');
  if (!SEMVER.test(version)) {
    throw new Error('Desktop plugin version must be a semantic version');
  }
  const description = publicText(field(manifest, 'description'), 'description');
  const author = {
    name: publicText(
      field(object(field(manifest, 'author'), 'author'), 'name'),
      'author.name',
    ),
  };
  const extensions = optionalObject(manifest, 'extensions', 'extensions');
  const openai = optionalObject(
    extensions,
    'com.openai',
    'extensions.com.openai',
  );
  const ui = optionalObject(openai, 'interface', 'OpenAI interface');
  const displayNameValue = field(ui, 'displayName');
  const displayName =
    displayNameValue === undefined
      ? name
      : publicText(displayNameValue, 'OpenAI interface displayName');

  const launcherConfig = object(launcher, 'launcher');
  const platform = field(launcherConfig, 'platform');
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(
      'Desktop plugin launcher platform must be darwin, win32, or linux',
    );
  }
  const executable = resolveLauncher(field(launcherConfig, 'executable'));
  const metadata = { name, version, description, author };
  const pluginDir = `plugins/${name}`;
  const source = `./${pluginDir}`;
  const files = {
    [`claude-desktop/${name}/manifest.json`]: {
      manifest_version: '0.3',
      ...metadata,
      display_name: displayName,
      compatibility: { platforms: [platform] },
      server: {
        type: 'binary',
        entry_point: executable,
        mcp_config: { command: `\${__dirname}/${executable}` },
      },
    },
    [`${pluginDir}/plugin.json`]: {
      $schema: `${AGENT_PLUGIN_SCHEMAS}/plugin.schema.json`,
      ...metadata,
      extensions: {
        'com.openai': {
          interface: { displayName, developerName: author.name },
        },
      },
    },
    [`${pluginDir}/mcp.json`]: {
      $schema: `${AGENT_PLUGIN_SCHEMAS}/mcp.schema.json`,
      mcpServers: {
        [name]: {
          type: 'stdio',
          command: `./${executable}`,
          cwd: `\${PLUGIN_ROOT}`,
        },
      },
    },
    [`${pluginDir}/.claude-plugin/plugin.json`]: {
      ...metadata,
      mcpServers: {
        [name]: { command: `\${CLAUDE_PLUGIN_ROOT}/${executable}` },
      },
    },
    '.agents/plugins/marketplace.json': {
      name,
      interface: { displayName },
      plugins: [
        {
          name,
          source: { source: 'local', path: source },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    },
    '.claude-plugin/marketplace.json': {
      name,
      description,
      owner: author,
      plugins: [{ name, source, description, category: 'productivity' }],
    },
  };
  return Object.fromEntries(
    Object.entries(files).map(([path, value]) => [
      path,
      `${JSON.stringify(value, null, 2)}\n`,
    ]),
  );
}
