import { SMRT_VERSION } from '../smrt-version.ts';
import { DEFAULT_EXPORT_NAME, slugify } from './file.ts';
import type { Cookbook } from './types.ts';

/**
 * The Export page's "Copy prompt for your coding agent": one block of text a
 * person pastes into a coding agent (Claude Code, Codex, …) to get a working
 * app from the cookbook. The cookbook travels inside it as plain minified
 * JSON in a quoted heredoc, so the agent writes the file byte for byte and
 * nothing in it is expanded by the shell.
 *
 * Every command here is the released CLI's (`smrt cookbook validate`,
 * `cookbook apply <file> <dir>`, `--into` for a second apply, `smrt app
 * install` / `app doctor`); keep them in step with `smrt --help`.
 */

/** Where the released packages are; the npmjs mirror lags (happyvertical/smrt#3963). */
export const SMRT_REGISTRY = 'https://npm.happyvertical.com/';
export const NPMRC_LINE = `@happyvertical:registry=${SMRT_REGISTRY}`;
/** The newest issue tracking the stale npmjs mirror. */
export const MIRROR_ISSUE = 'happyvertical/smrt#3963';
/** What `@happyvertical/smrt-core`, the CLI and the smrt-start template require. */
export const NODE_REQUIREMENT = 'Node 26 or newer';
export const PNPM_REQUIREMENT = 'pnpm 11';

export const COOKBOOK_FILE = 'cookbook.json';
const DELIMITER_BASE = 'COOKBOOK_EOF';

/** `npx -y @happyvertical/smrt-cli@<version>`, the CLI without a global install. */
export function cliCommand(version = SMRT_VERSION): string {
  return `npx -y @happyvertical/smrt-cli@${version}`;
}

/** The app directory `cookbook apply` creates: the cookbook's name as a slug, else the export name, else `my-app`. */
export function appNameFor(cookbook: Cookbook, fallbackName?: string): string {
  return slugify(cookbook.name) || slugify(fallbackName) || DEFAULT_EXPORT_NAME;
}

/** `… cookbook apply <file> <app>`, the one command the downloaded file needs. */
export function applyCommand(
  fileName: string,
  appName: string,
  version = SMRT_VERSION,
): string {
  return `${cliCommand(version)} cookbook apply ${fileName} ${appName}`;
}

/**
 * A heredoc delimiter no line of `body` equals. Minified JSON is one line
 * starting with `{`, so the base is normally fine; a body that does carry
 * the delimiter on a line of its own gets a numbered one.
 */
export function heredocDelimiter(body: string, base = DELIMITER_BASE): string {
  const lines = new Set(body.split('\n'));
  let delimiter = base;
  for (let n = 1; lines.has(delimiter); n++) delimiter = `${base}_${n}`;
  return delimiter;
}

/** `cat > <file> <<'<delimiter>'` … `<delimiter>`, quoted so nothing expands. */
export function heredoc(file: string, body: string): string {
  const delimiter = heredocDelimiter(body);
  return `cat > ${file} <<'${delimiter}'\n${body}\n${delimiter}`;
}

/** The body of the quoted heredoc that writes `file` in `text`; undefined when there is none. */
export function heredocBody(text: string, file: string): string | undefined {
  const lines = text.split('\n');
  const prefix = `cat > ${file} <<'`;
  const start = lines.findIndex(
    (line) => line.startsWith(prefix) && line.endsWith("'"),
  );
  if (start < 0) return undefined;
  const delimiter = lines[start].slice(prefix.length, -1);
  const end = lines.indexOf(delimiter, start + 1);
  return end < 0 ? undefined : lines.slice(start + 1, end).join('\n');
}

export interface AgentPrompt {
  text: string;
  /** UTF-8 bytes of `text`. */
  bytes: number;
  appName: string;
  version: string;
  delimiter: string;
}

export interface AgentPromptOptions {
  /** Names the app when the cookbook has no `name` (the library cookbook applied). */
  fallbackName?: string;
  version?: string;
}

/** The whole prompt for one cookbook. Pure; the page only copies it. */
export function buildAgentPrompt(
  cookbook: Cookbook,
  options: AgentPromptOptions = {},
): AgentPrompt {
  const version = options.version ?? SMRT_VERSION;
  const appName = appNameFor(cookbook, options.fallbackName);
  const json = JSON.stringify(cookbook);
  const delimiter = heredocDelimiter(json);
  const cli = cliCommand(version);
  const text = [
    `Create a new s-m-r-t app from the cookbook below. Work in a new, empty directory outside any existing project, run the steps in order, and when you finish report what you ran and what happened, including anything that failed.`,
    '',
    `1. Prerequisites: ${NODE_REQUIREMENT} (\`node --version\`), git, and ${PNPM_REQUIREMENT} or newer (\`npm install -g pnpm\` if missing).`,
    '',
    `2. The @happyvertical packages are published on the HappyVertical registry; the npmjs mirror is currently stale (${MIRROR_ISSUE}), so write this .npmrc in the directory first:`,
    '',
    `cat > .npmrc <<'EOF'\n${NPMRC_LINE}\nEOF`,
    '',
    `3. Write the cookbook exactly as given, without reformatting or editing it:`,
    '',
    `cat > ${COOKBOOK_FILE} <<'${delimiter}'\n${json}\n${delimiter}`,
    '',
    `4. Validate it, then create the app in ./${appName}:`,
    '',
    `${cli} cookbook validate ${COOKBOOK_FILE}`,
    `${cli} cookbook apply ${COOKBOOK_FILE} ${appName}`,
    '',
    `5. Set it up and start it:`,
    '',
    `cd ${appName} && pnpm exec smrt app install`,
    '',
    `If any step fails, run \`pnpm exec smrt app doctor\` inside ${appName} and include its findings in your report. Do not hand-edit the app's smrt.cookbook.json: change ${COOKBOOK_FILE} and run \`${cli} cookbook apply ${COOKBOOK_FILE} --into ${appName}\` instead.`,
    '',
  ].join('\n');
  return {
    text,
    bytes: new TextEncoder().encode(text).length,
    appName,
    version,
    delimiter,
  };
}
