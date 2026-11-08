/**
 * `smrt doctor --ai` section (#4752): an unresolvable binding is an issue,
 * a chain that resolves past a bad candidate is a warning. No network.
 */
import { describe, expect, it } from 'vitest';
import { runInferenceDoctorSection } from '../doctor-ai.js';
import { utilityCommands } from '../utilities.js';

describe('doctor --ai', () => {
  it('declares the --ai and --probe options', () => {
    const doctor = utilityCommands.doctor;
    expect(doctor?.options?.ai).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(doctor?.options?.probe).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('passes an unconfigured app', async () => {
    const section = await runInferenceDoctorSection({
      config: undefined,
      env: {},
    });
    expect(section.issues).toEqual([]);
    expect(section.passed).toEqual(['Inference bindings']);
    expect(section.lines.join('\n')).toContain('configured AI client');
  });

  it('turns an unknown alias into an issue naming the tier', async () => {
    const section = await runInferenceDoctorSection({
      config: { tiers: { great: { alias: 'frontier' } } },
      env: {},
    });
    expect(section.issues).toEqual([
      expect.stringContaining(
        'inference tier:great cannot resolve: inference.tiers.great points at unknown alias "frontier"',
      ),
    ]);
  });

  it('warns for a chain that still resolves', async () => {
    const section = await runInferenceDoctorSection({
      config: {
        aliases: {
          frontier: {
            candidates: [
              { provider: 'not-a-provider', model: 'x' },
              { provider: 'ollama', model: 'llama3' },
            ],
          },
        },
        tiers: { great: { alias: 'frontier' } },
      },
      env: {},
    });
    expect(section.issues).toEqual([]);
    expect(section.warnings).toEqual([
      'inference tier:great: alias:frontier has a candidate that cannot answer',
      expect.stringContaining('not-a-provider/x'),
    ]);
  });
});
