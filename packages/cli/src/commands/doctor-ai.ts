/**
 * `smrt doctor --ai [--probe]` (#4752): the inference binding section.
 *
 * A thin wrapper over `checkInferenceBindings()` from
 * `@happyvertical/smrt-inference/node`, which reads the merged `inference`
 * config the CLI loaded at startup. Offline by default; `--probe` calls each
 * candidate's list endpoint with a short timeout. An unresolvable binding is
 * a doctor issue (non-zero exit); an unusable candidate in a chain that still
 * resolves is a warning.
 */
import type {
  CheckInferenceBindingsOptions,
  InferenceDoctorReport,
} from '@happyvertical/smrt-inference/node';

/** What the doctor section contributes to the summary. */
export interface InferenceDoctorSection {
  lines: string[];
  issues: string[];
  warnings: string[];
  passed: string[];
  report: InferenceDoctorReport;
}

/** Run the check and shape it for `smrt doctor`. */
export async function runInferenceDoctorSection(
  options: CheckInferenceBindingsOptions = {},
): Promise<InferenceDoctorSection> {
  const { checkInferenceBindings, formatInferenceDoctorReport } = await import(
    '@happyvertical/smrt-inference/node'
  );
  const report = await checkInferenceBindings(options);
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const binding of report.bindings) {
    const detail = binding.problems.join('; ');
    if (binding.status === 'error') {
      issues.push(
        `inference ${binding.binding} cannot resolve${detail ? `: ${detail}` : ''}`,
      );
    } else if (binding.status === 'warn') {
      warnings.push(
        `inference ${binding.binding}: ${
          detail ||
          binding.candidates
            .filter((candidate) => candidate.status !== 'ok')
            .map(
              (candidate) =>
                `${candidate.label} (${candidate.problems.join('; ')})`,
            )
            .join(', ')
        }`,
      );
    }
  }
  return {
    lines: formatInferenceDoctorReport(report),
    issues,
    warnings,
    passed: report.ok && warnings.length === 0 ? ['Inference bindings'] : [],
    report,
  };
}
