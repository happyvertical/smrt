/**
 * deploy:check and deploy:chart-values
 *
 * Read the project's Compose file as a deployment declaration (the
 * `x-happyvertical` contract in `@happyvertical/smrt-config/deployment`).
 * `deploy:check` validates it; `deploy:chart-values` renders it as values for
 * the `smrt-app` chart. Neither command contacts a cluster or a registry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type ComposeDeploymentResult,
  type ComposeDeploymentStage,
  formatComposeDeploymentReport,
  renderSmrtAppChartValues,
  type SmrtAppChartInputs,
  SmrtAppChartValuesError,
  validateComposeDeployment,
} from '@happyvertical/smrt-config/deployment';
import { parse } from 'yaml';
import type { CLICommand } from '../cli-generator.js';

/** Compose file names in the order Compose itself looks for them. */
export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

export class DeployCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployCommandError';
  }
}

interface DeployOptions {
  deploy?: boolean;
  image?: string | string[];
  json?: boolean;
  inputs?: string;
}

/** Resolve the Compose file to read: an explicit path, or the first default name present. */
export function resolveComposeFile(
  cwd: string,
  file: string | undefined,
): string {
  if (file) {
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    if (!existsSync(path)) {
      throw new DeployCommandError(`There is no file at ${path}.`);
    }
    return path;
  }
  for (const name of COMPOSE_FILE_NAMES) {
    const path = join(cwd, name);
    if (existsSync(path)) return path;
  }
  throw new DeployCommandError(
    `No Compose file found in ${cwd}. Looked for ${COMPOSE_FILE_NAMES.join(', ')}. Pass the path as an argument.`,
  );
}

/** Parse `--image service=registry/name@sha256:…` occurrences into a map. */
export function parseImageOptions(
  value: string | string[] | undefined,
): Record<string, string> {
  const images: Record<string, string> = {};
  const entries =
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1 || separator === entry.length - 1) {
      throw new DeployCommandError(
        `--image expects service=image, for example web=ghcr.io/acme/web@sha256:… (got "${entry}").`,
      );
    }
    images[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return images;
}

/** Read and validate one Compose file. YAML merge keys (`<<`) are honoured as Compose does. */
export function checkComposeFile(
  path: string,
  options: { stage?: ComposeDeploymentStage; images?: Record<string, string> },
): ComposeDeploymentResult {
  let document: unknown;
  try {
    document = parse(readFileSync(path, 'utf8'), { merge: true });
  } catch (error) {
    throw new DeployCommandError(
      `${path} is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
  return validateComposeDeployment(document, options);
}

function stageOf(
  options: DeployOptions,
  images: Record<string, string>,
): ComposeDeploymentStage {
  return options.deploy || Object.keys(images).length > 0
    ? 'deploy'
    : 'declare';
}

const sharedOptions = {
  image: {
    type: 'string' as const,
    multiple: true,
    description:
      'Image digest for a service, as service=registry/name@sha256:… (repeatable). Implies --deploy.',
  },
};

export const deployCheckCommand: CLICommand = {
  name: 'deploy:check',
  description:
    'Check the Compose file as a deployment declaration (x-happyvertical contract)',
  aliases: ['deploy-check'],
  args: ['[file]'],
  options: {
    ...sharedOptions,
    deploy: {
      type: 'boolean',
      description:
        'Check as a release: every web and worker service must resolve to an image digest',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Print the result as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (args: string[], options: DeployOptions) => {
    try {
      const path = resolveComposeFile(process.cwd(), args[0]);
      const images = parseImageOptions(options.image);
      const result = checkComposeFile(path, {
        stage: stageOf(options, images),
        images,
      });
      console.log(
        options.json
          ? JSON.stringify({ file: path, ...result }, null, 2)
          : `${path}\n${formatComposeDeploymentReport(result)}\n`,
      );
      if (!result.ok) process.exit(1);
    } catch (error) {
      if (!(error instanceof DeployCommandError)) throw error;
      console.error(error.message);
      process.exit(1);
    }
  },
};

export const deployChartValuesCommand: CLICommand = {
  name: 'deploy:chart-values',
  description:
    'Render the Compose deployment declaration as smrt-app chart values (JSON on stdout)',
  aliases: ['deploy-chart-values'],
  args: ['[file]'],
  options: {
    ...sharedOptions,
    inputs: {
      type: 'string',
      description:
        'JSON file with the environment-owned inputs: release, app, bindings, defaults, maintenance, ingress',
      short: 'i',
    },
  },
  handler: async (args: string[], options: DeployOptions) => {
    try {
      const cwd = process.cwd();
      const path = resolveComposeFile(cwd, args[0]);
      if (!options.inputs) {
        throw new DeployCommandError(
          'deploy:chart-values needs --inputs <file.json> with the release, Secret references and resources of the environment.',
        );
      }
      const inputsPath = isAbsolute(options.inputs)
        ? options.inputs
        : resolve(cwd, options.inputs);
      if (!existsSync(inputsPath)) {
        throw new DeployCommandError(`There is no file at ${inputsPath}.`);
      }
      let inputs: SmrtAppChartInputs;
      try {
        inputs = JSON.parse(readFileSync(inputsPath, 'utf8'));
      } catch (error) {
        throw new DeployCommandError(
          `${inputsPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const result = checkComposeFile(path, {
        stage: 'deploy',
        images: parseImageOptions(options.image),
      });
      if (!result.ok || !result.declaration) {
        throw new DeployCommandError(
          `${path}\n${formatComposeDeploymentReport(result)}`,
        );
      }
      console.log(
        JSON.stringify(
          renderSmrtAppChartValues(result.declaration, inputs),
          null,
          2,
        ),
      );
    } catch (error) {
      if (
        !(error instanceof DeployCommandError) &&
        !(error instanceof SmrtAppChartValuesError)
      ) {
        throw error;
      }
      console.error(error.message);
      process.exit(1);
    }
  },
};

export const deployCommands: Record<string, CLICommand> = {
  'deploy:check': deployCheckCommand,
  'deploy:chart-values': deployChartValuesCommand,
};
