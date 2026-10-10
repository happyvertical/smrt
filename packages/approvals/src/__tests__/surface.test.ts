/**
 * The generated surface is read-only: requests, events, and policies expose
 * list/get over REST and MCP and no CLI; every write goes through
 * ApprovalService. Events are append-only at the model layer too.
 */

import {
  getTestDatabase,
  MCPGenerator,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalEventCollection } from '../collections/ApprovalEventCollection.js';
import { ApprovalRequestCollection } from '../collections/ApprovalRequestCollection.js';
import { ApprovalService } from '../service.js';
import { approvalPrincipalFromPermissions } from '../types.js';
import { singleKind } from './helpers/approval-suite.js';
import { APPROVAL_CLASSES } from './helpers/classes.js';

const PACKAGE = '@happyvertical/smrt-approvals';
const MODELS = ['ApprovalRequest', 'ApprovalEvent', 'ApprovalPolicy'];
const CLASSES = [...MODELS, ...MODELS.map((model) => `${model}Collection`)];

type SurfaceConfig = {
  api?: boolean | { include?: string[] };
  mcp?: boolean | { include?: string[] };
  cli?: boolean | { include?: string[] };
};

function config(name: string): SurfaceConfig {
  const registered = ObjectRegistry.getClassInPackage(PACKAGE, name);
  expect(registered, `${name} must be registered`).toBeTruthy();
  return (registered as { config: SurfaceConfig }).config;
}

describe('generated surface', () => {
  it.each(CLASSES)('%s exposes list/get only, and no CLI', (model) => {
    const surface = config(model);
    expect(surface.api).toEqual({ include: ['list', 'get'] });
    expect(surface.mcp).toEqual({ include: ['list', 'get'] });
    expect(surface.cli).toBe(false);
  });

  it('generates no MCP write tool for any approval model', async () => {
    const tools = await new MCPGenerator().generateTools();
    const ours = tools
      .map((tool) => tool.name)
      .filter((name) => /approval/i.test(name));
    expect(ours.length).toBeGreaterThan(0);
    for (const name of ours) {
      expect(name).toMatch(/_(list|get)$/);
    }
  });
});

describe('append-only models', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: APPROVAL_CLASSES,
    });
  });

  afterAll(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('refuses to update or delete an event, or re-save or delete a request', async () => {
    const tenantId = crypto.randomUUID();
    const service = new ApprovalService({ db });
    const requester = approvalPrincipalFromPermissions([], {
      id: 'requester',
      tenantId,
      type: 'human',
    });
    const { request } = await service.requestApproval(requester, {
      kind: singleKind,
      subjectId: 'post-1',
      subjectRevisionHash: 'rev-1',
    });
    const id = String(request?.id);

    const events = await ApprovalEventCollection.create({ db });
    const [event] = await events.list({ where: { requestId: id } });
    expect(event).toBeTruthy();
    event.reason = 'rewritten history';
    await expect(event.save()).rejects.toMatchObject({
      code: 'APPROVAL_FORBIDDEN',
    });
    await expect(event.delete()).rejects.toMatchObject({
      code: 'APPROVAL_FORBIDDEN',
    });

    const requests = await ApprovalRequestCollection.create({ db });
    const [row] = await requests.list({ where: { id } });
    row.status = 'approved';
    await expect(row.save()).rejects.toMatchObject({
      code: 'APPROVAL_FORBIDDEN',
    });
    await expect(row.delete()).rejects.toMatchObject({
      code: 'APPROVAL_FORBIDDEN',
    });

    const [fresh] = await requests.list({ where: { id } });
    expect(fresh.status).toBe('pending');
    expect(await events.list({ where: { requestId: id } })).toHaveLength(1);
  });
});
