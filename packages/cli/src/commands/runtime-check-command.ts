import type { CLICommand } from '../cli-generator.js';
import {
  formatRuntimeCheckReport,
  type RuntimeCheckResult,
  runRuntimeCheck,
} from '../runtime-check.js';

export async function runRuntimeCheckSafely(
  projectRoot: string,
): Promise<RuntimeCheckResult> {
  try {
    return await runRuntimeCheck(projectRoot);
  } catch (error) {
    return {
      projectRoot,
      discoveredManifestCount: 0,
      findings: [
        {
          severity: 'error',
          code: 'runtime-check-crashed',
          message: `Runtime diagnostics crashed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

export const runtimeCheckCommand: CLICommand = {
  name: 'runtime:check',
  description:
    'Validate runtime manifest discovery, package identity, and registry hydration',
  aliases: ['runtime-check'],
  args: [],
  options: {},
  handler: async () => {
    const result = await runRuntimeCheckSafely(process.cwd());
    console.log(`${formatRuntimeCheckReport(result)}\n`);

    if (result.findings.some((finding) => finding.severity === 'error')) {
      process.exit(1);
    }
  },
};
