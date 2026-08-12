import type { DatabaseInterface } from '@happyvertical/sql';
import { DevelopmentRequestCollection } from './collections/DevelopmentRequests';
import { ProjectIntegrationCollection } from './collections/ProjectIntegrations';
import type { ProjectIntegration } from './models/ProjectIntegration';
import {
  type ProjectBoardMoveIntent,
  ProjectBoardService,
} from './services/project-board-service';
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
    const integration = await this.#requireCapability('requests:create');
    if (!input.description.trim()) {
      throw new Error('Managed request creation requires a description');
    }

    const requests = await DevelopmentRequestCollection.create({
      db: this.#db,
    });
    return requests.createManaged({
      ...input,
      tenantId: integration.tenantId,
      projectId: integration.projectId,
      integrationId: integration.id as string,
      requesterId: this.#requesterId,
    });
  }

  async listRequests() {
    const integration = await this.#requireCapability('requests:read-own');
    const requests = await DevelopmentRequestCollection.create({
      db: this.#db,
    });
    return requests.listByIntegrationRequester({
      tenantId: integration.tenantId,
      integrationId: integration.id as string,
      requesterId: this.#requesterId,
    });
  }

  /**
   * Move a project-board item through this authenticated integration.
   *
   * The browser submits only the move intent. This client keeps the credential
   * authentication boundary server-side and ProjectBoardService reloads active
   * capability state again immediately before the provider mutation.
   */
  async moveProjectBoardItem(input: ProjectBoardMoveIntent) {
    const integration = await this.#requireCapability('projects:write');
    const service = await ProjectBoardService.create({ db: this.#db });
    return service.moveItem(integration, input);
  }

  async #requireCapability(capability: string): Promise<ProjectIntegration> {
    const tenantId = this.#integration.tenantId;
    const integrationId = this.#integration.id;
    if (!tenantId || !integrationId) {
      throw new Error('Invalid or revoked project integration credential');
    }
    const integrations = await ProjectIntegrationCollection.create({
      db: this.#db,
    });
    const integration = await integrations.findActive(tenantId, integrationId);
    if (!integration) {
      throw new Error('Invalid or revoked project integration credential');
    }
    if (!integration.hasCapability(capability)) {
      throw new Error(
        `Managed project integration lacks required capability '${capability}'`,
      );
    }
    return integration;
  }
}
