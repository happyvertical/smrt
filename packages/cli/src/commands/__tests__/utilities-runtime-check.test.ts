import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  formatRuntimeCheckReport: vi.fn(
    (result: { findings: Array<{ code: string }> }) =>
      `report:${result.findings[0]?.code || 'ok'}`,
  ),
  runRuntimeCheck: vi.fn(),
}));

vi.mock('../../runtime-check.js', () => ({
  formatRuntimeCheckReport: mocks.formatRuntimeCheckReport,
  runRuntimeCheck: mocks.runRuntimeCheck,
}));

describe('runtime-check utilities', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.formatRuntimeCheckReport.mockClear();
    mocks.runRuntimeCheck.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps runtime-check crashes into structured findings', async () => {
    mocks.runRuntimeCheck.mockRejectedValueOnce(new Error('boom'));

    const { runRuntimeCheckSafely } = await import('../utilities.js');
    const result = await runRuntimeCheckSafely('/tmp/runtime-check-fixture');

    expect(result).toEqual(
      expect.objectContaining({
        projectRoot: '/tmp/runtime-check-fixture',
        findings: [
          expect.objectContaining({
            severity: 'error',
            code: 'runtime-check-crashed',
            message: expect.stringContaining('boom'),
          }),
        ],
      }),
    );
  });

  it('uses the safe wrapper for the runtime:check command', async () => {
    mocks.runRuntimeCheck.mockRejectedValueOnce(new Error('boom'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    const { utilityCommands } = await import('../utilities.js');

    await expect(utilityCommands['runtime:check'].handler()).rejects.toThrow(
      'exit:1',
    );
    expect(mocks.formatRuntimeCheckReport).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [
          expect.objectContaining({
            code: 'runtime-check-crashed',
          }),
        ],
      }),
    );
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
