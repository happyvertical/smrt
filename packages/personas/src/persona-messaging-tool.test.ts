import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { describe, expect, it, vi } from 'vitest';
import {
  createPersonaMessagingTool,
  SEND_PERSONA_MESSAGE_TOOL_SLUG,
} from './persona-messaging-tool.js';

function run(
  options: {
    tenantId?: string | null;
    permissions?: string[];
    allowed?: boolean;
  } = {},
): PrincipalRun {
  return {
    context: {
      userId: 'user-1',
      tenantId: options.tenantId === undefined ? 'tenant-1' : options.tenantId,
    },
    permissions: options.permissions ?? ['messages.send'],
    allowedTools: options.allowed === false ? [] : ['messages.send'],
    isToolAllowed: () => options.allowed !== false,
    assertToolAllowed: (slug: string) => {
      if (options.allowed === false) throw new Error(`not allowed: ${slug}`);
    },
    assertOperation: vi.fn(),
  } as unknown as PrincipalRun;
}

describe('createPersonaMessagingTool', () => {
  it('fixes persona and tenant scope outside model-controlled arguments', async () => {
    const send = vi.fn(async (input) => ({ ok: true, input }));
    const tool = createPersonaMessagingTool({
      personaId: 'persona-trusted',
      tenantId: 'tenant-1',
      createService: ({ tenantId, permissions }) => {
        expect(tenantId).toBe('tenant-1');
        expect(permissions).toContain('messages.send');
        return { send };
      },
    });

    await tool.execute({
      run: run(),
      args: {
        body: '  Hello  ',
        channel: 'telegram',
        personaId: 'persona-attacker',
        accountId: 'account-attacker',
      },
    });

    expect(tool.slug).toBe(SEND_PERSONA_MESSAGE_TOOL_SLUG);
    expect(send).toHaveBeenCalledWith({
      personaId: 'persona-trusted',
      body: 'Hello',
      channel: 'telegram',
    });
  });

  it('fails closed on persona tool and RBAC gates', async () => {
    const deniedTool = createPersonaMessagingTool({
      personaId: 'persona-1',
      createService: () => ({ send: vi.fn() }),
    });
    await expect(
      deniedTool.execute({ run: run({ allowed: false }), args: { body: 'x' } }),
    ).rejects.toThrow('not allowed');
    await expect(
      deniedTool.execute({
        run: run({ permissions: [] }),
        args: { body: 'x' },
      }),
    ).rejects.toThrow("Missing required permission 'messages.send'");
  });

  it('fails fast when the default service has no database connection', async () => {
    const tool = createPersonaMessagingTool({ personaId: 'persona-1' });

    await expect(
      tool.execute({ run: run(), args: { body: 'Hello' } }),
    ).rejects.toThrow(
      'A database connection is required to send persona messages.',
    );
  });
});
