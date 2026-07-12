import type { DatabaseInterface } from '@happyvertical/sql';
import { DevelopmentRequestCollection } from './collections/DevelopmentRequests';
import { ProjectIntegrationCollection } from './collections/ProjectIntegrations';
import type { ProjectIntegration } from './models/ProjectIntegration';
import type { ManagedDevelopmentRequestCreateInput } from './types';

export class ManagedProjectClient {
  readonly #db: DatabaseInterface;
  readonly #integration: ProjectIntegration;
  readonly #requesterId: string;

  private constructor(
    integration: ProjectIntegration,
    options: { db: DatabaseInterface; requesterId: string },
  ) {
    this.#integration = integration;
    this.#db = options.db;
    this.#requesterId = options.requesterId;
  }

  static async authenticate(
    credential: string,
    options: { db: DatabaseInterface; requesterId: string },
  ): Promise<ManagedProjectClient> {
    if (!options.requesterId.trim()) {
      throw new Error('Managed project client requires a stable requesterId');
    }
    const integrations = await ProjectIntegrationCollection.create({
      db: options.db,
    });
    const integration = await integrations.authenticate(credential);
    if (!integration) {
      throw new Error('Invalid or revoked project integration credential');
    }
    return new ManagedProjectClient(integration, options);
  }

  async createRequest(
    input: Omit<ManagedDevelopmentRequestCreateInput, 'requesterId'>,
  ) {
    this.#requireCapability('requests:create');
    if (!input.description.trim()) {
      throw new Error('Managed request creation requires a description');
    }

    const requests = await DevelopmentRequestCollection.create({
      db: this.#db,
    });
    return requests.createManaged({
      ...input,
      tenantId: this.#integration.tenantId,
      projectId: this.#integration.projectId,
      integrationId: this.#integration.id as string,
      requesterId: this.#requesterId,
    });
  }

  async listRequests() {
    this.#requireCapability('requests:read-own');
    const requests = await DevelopmentRequestCollection.create({
      db: this.#db,
    });
    return requests.listByIntegrationRequester({
      tenantId: this.#integration.tenantId,
      integrationId: this.#integration.id as string,
      requesterId: this.#requesterId,
    });
  }

  #requireCapability(capability: string): void {
    if (!this.#integration.hasCapability(capability)) {
      throw new Error(
        `Managed project integration lacks required capability '${capability}'`,
      );
    }
  }
}
