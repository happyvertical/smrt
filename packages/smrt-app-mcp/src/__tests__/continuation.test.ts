import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  continueMcpWorkflow,
  createMcpContinuationTool,
} from '../continuation.js';

const mocks = vi.hoisted(() => ({
  active: true,
  assertAuthorized: vi.fn(),
  requestContinuation: vi.fn(),
}));
vi.mock('@happyvertical/smrt-jobs', () => ({
  getActiveJobExecutionContext: () =>
    mocks.active ? { task: mocks } : undefined,
  isRunnerExecutionContext: () => mocks.active,
}));

const binding = {
  recordId: 'review-1',
  revision: 'revision-1',
  inputKey: 'input',
  reviewUrl: 'https://app.example/reviews/review-1',
};
beforeEach(() => {
  mocks.active = true;
  mocks.assertAuthorized.mockReset().mockResolvedValue(undefined);
  mocks.requestContinuation.mockReset().mockResolvedValue({ confirmed: true });
});

describe('application continuation composition', () => {
  it('offers an authenticated review-page fallback and delegates immutable approval to its owner', async () => {
    const applyReviewed = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'domain_approval_required' });
    const result = await continueMcpWorkflow({
      binding,
      inputSchema: { type: 'object' },
      applyReviewed,
    });
    expect(result).toEqual({ ok: false, reason: 'domain_approval_required' });
    expect(mocks.requestContinuation).toHaveBeenCalledWith(
      { recordId: 'review-1', revision: 'revision-1', inputKey: 'input' },
      { schema: { type: 'object' }, reviewUrl: binding.reviewUrl },
    );
    expect(applyReviewed).toHaveBeenCalledWith(
      { confirmed: true },
      { recordId: 'review-1', revision: 'revision-1', inputKey: 'input' },
    );
    expect(mocks.assertAuthorized).toHaveBeenCalledTimes(2);
  });

  it('does not apply while suspended or when authority is revoked after input', async () => {
    const applyReviewed = vi.fn();
    mocks.requestContinuation.mockRejectedValueOnce(new Error('suspended'));
    await expect(
      continueMcpWorkflow({ binding, inputSchema: {}, applyReviewed }),
    ).rejects.toThrow('suspended');
    mocks.requestContinuation.mockResolvedValue({ confirmed: true });
    mocks.assertAuthorized
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(
      continueMcpWorkflow({ binding, inputSchema: {}, applyReviewed }),
    ).rejects.toThrow('revoked');
    expect(applyReviewed).not.toHaveBeenCalled();
  });

  it('rejects missing execution context and unsafe fallback URLs', async () => {
    const applyReviewed = vi.fn();
    mocks.active = false;
    await expect(
      continueMcpWorkflow({ binding, inputSchema: {}, applyReviewed }),
    ).rejects.toThrow('active MCP task');
    mocks.active = true;
    for (const reviewUrl of [
      'javascript:alert(1)',
      'https://secret:password@app.example/review',
    ]) {
      await expect(
        continueMcpWorkflow({
          binding: { ...binding, reviewUrl },
          inputSchema: {},
          applyReviewed,
        }),
      ).rejects.toThrow('HTTPS');
    }
    expect(applyReviewed).not.toHaveBeenCalled();
  });
});

describe('ordinary tool fallback without elicitation', () => {
  it('reads through the verified principal store and returns a usable form/URL', async () => {
    const principal = { id: 'actor-a', tenantId: 'tenant-a' };
    const continuation = {
      binding,
      inputRequests: {
        input: { reviewUrl: binding.reviewUrl, schema: { type: 'object' } },
      },
    };
    const storeFor = vi.fn().mockResolvedValue({
      getContinuation: vi.fn().mockResolvedValue(continuation),
    });
    const authorize = vi.fn().mockResolvedValue(true);
    const tool = createMcpContinuationTool({
      name: 'workflow_input',
      storeFor,
      authorize,
    });
    const result = await tool.execute({
      arguments: { taskId: 'task-a' },
      principal,
    });
    expect(result.structuredContent).toEqual({ continuation });
    expect(storeFor).toHaveBeenCalledWith(principal);
    expect(authorize).toHaveBeenCalledWith(principal, 'task-a');
  });

  it('fails closed for absent principal, revoked authority, malformed input and upstream errors', async () => {
    const storeFor = vi.fn().mockRejectedValue(new Error('private DB details'));
    const authorize = vi.fn().mockResolvedValue(false);
    const tool = createMcpContinuationTool({
      name: 'workflow_input',
      storeFor,
      authorize,
    });
    const principal = { id: 'actor-a' };
    for (const context of [
      { arguments: { taskId: 'task-a' }, principal: null },
      { arguments: { taskId: null }, principal },
      { arguments: { taskId: 'task-a' }, principal },
    ]) {
      await expect(tool.execute(context)).rejects.toThrow('Tool access denied');
    }
    expect(storeFor).not.toHaveBeenCalled();
    authorize.mockResolvedValue(true);
    await expect(
      tool.execute({ arguments: { taskId: 'task-a' }, principal }),
    ).rejects.toThrow('Tool access denied');
  });
});
