import { createHash, randomBytes } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { ProjectIntegration } from '../models/ProjectIntegration';
import type { ProjectIntegrationCapability } from '../types';
import { ProjectIntegrationAuditCollection } from './ProjectIntegrationAudits';

export class ProjectIntegrationCollection extends SmrtCollection<ProjectIntegration> {
  static readonly _itemClass = ProjectIntegration;

  async provision(input: {
    tenantId: string;
    projectId: string;
    name: string;
    capabilities: ProjectIntegrationCapability[];
  }): Promise<{ integration: ProjectIntegration; credential: string }> {
    const credential = issueProjectIntegrationCredential(input.tenantId);
    const integration = await withTenant({ tenantId: input.tenantId }, () =>
      this.create({
        tenantId: input.tenantId,
        projectId: input.projectId,
        name: input.name,
        capabilities: [...input.capabilities],
        credentialHash: hashProjectIntegrationCredential(credential),
        status: 'active',
        revokedAt: null,
      }),
    );
    await withTenant({ tenantId: input.tenantId }, () => integration.save());
    await this.recordAudit(integration, 'created');
    return { integration, credential };
  }

  async rotate(
    tenantId: string,
    integrationId: string,
  ): Promise<{ integration: ProjectIntegration; credential: string }> {
    const integration = await this.requireActive(tenantId, integrationId);
    const credential = issueProjectIntegrationCredential(integration.tenantId);
    integration.credentialHash = hashProjectIntegrationCredential(credential);
    await withTenant({ tenantId: integration.tenantId }, () =>
      integration.save(),
    );
    await this.recordAudit(integration, 'rotated');
    return { integration, credential };
  }

  async revoke(
    tenantId: string,
    integrationId: string,
  ): Promise<ProjectIntegration> {
    const integration = await this.requireExisting(tenantId, integrationId);
    integration.status = 'revoked';
    integration.revokedAt = new Date();
    integration.credentialHash = '';
    await withTenant({ tenantId: integration.tenantId }, () =>
      integration.save(),
    );
    await this.recordAudit(integration, 'revoked');
    return integration;
  }

  async authenticate(credential: string): Promise<ProjectIntegration | null> {
    const tenantId = parseCredentialTenant(credential);
    if (!tenantId) return null;
    const credentialHash = hashProjectIntegrationCredential(credential);
    const integrations = await withTenant({ tenantId }, () =>
      this.list({ where: { tenantId, status: 'active' } }),
    );
    const integration = integrations.find(
      (candidate) => candidate.credentialHash === credentialHash,
    );
    return integration?.isActive() ? integration : null;
  }

  async listForProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectIntegration[]> {
    return withTenant({ tenantId }, () =>
      this.list({
        where: { tenantId, projectId },
        orderBy: 'name ASC',
      }),
    );
  }

  async findActive(
    tenantId: string,
    integrationId: string,
  ): Promise<ProjectIntegration | null> {
    const integration = await withTenant({ tenantId }, () =>
      this.findOne({ where: { id: integrationId, tenantId } }),
    );
    return integration?.isActive() ? integration : null;
  }

  private async requireExisting(
    tenantId: string,
    integrationId: string,
  ): Promise<ProjectIntegration> {
    const integration = await withTenant({ tenantId }, () =>
      this.findOne({ where: { id: integrationId, tenantId } }),
    );
    if (!integration) {
      throw new Error(`ProjectIntegration ${integrationId} not found`);
    }
    return integration;
  }

  private async requireActive(
    tenantId: string,
    integrationId: string,
  ): Promise<ProjectIntegration> {
    const integration = await this.requireExisting(tenantId, integrationId);
    if (!integration.isActive()) {
      throw new Error(`ProjectIntegration ${integrationId} is not active`);
    }
    return integration;
  }

  private async recordAudit(
    integration: ProjectIntegration,
    action: 'created' | 'rotated' | 'revoked',
  ): Promise<void> {
    const audits = await ProjectIntegrationAuditCollection.create(this.options);
    const entry = await withTenant({ tenantId: integration.tenantId }, () =>
      audits.create({
        tenantId: integration.tenantId,
        integrationId: integration.id as string,
        action,
      }),
    );
    await withTenant({ tenantId: integration.tenantId }, () => entry.save());
  }
}

export function hashProjectIntegrationCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

function issueProjectIntegrationCredential(tenantId: string): string {
  const tenant = Buffer.from(tenantId, 'utf8').toString('base64url');
  return `smrt_pi_${tenant}_${randomBytes(24).toString('hex')}`;
}

function parseCredentialTenant(credential: string): string | null {
  const match = /^smrt_pi_([A-Za-z0-9_-]+)_[a-f0-9]{48}$/.exec(credential);
  if (!match) return null;
  try {
    const tenantId = Buffer.from(match[1], 'base64url').toString('utf8');
    return tenantId.length > 0 ? tenantId : null;
  } catch {
    return null;
  }
}
