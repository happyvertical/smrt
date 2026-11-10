import { withPrivateAssetAccess } from '@happyvertical/smrt-assets';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CatalogAuthorizer } from './catalog-service.js';
import type {
  FamilyIntakeAuthorizer,
  FamilyIntakeRequest,
  FamilyIntakeSource,
  FamilyIntakeView,
} from './family-intake-contracts.js';
import {
  FamilyIntakeAssetCollection,
  FamilyIntakeCollection,
  FamilyIntakeDecisionCollection,
} from './family-intake-models.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
} from './learner-service.js';
import type {
  SubmissionPage,
  SubmissionServiceOptions,
} from './submission-service.js';
import {
  WorkbookPhotoAssetCollection,
  WorkbookPhotoIntakeCollection,
} from './workbook-photo-models.js';
import { WorkbookPhotoService } from './workbook-photo-service.js';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
function digest(value: string | Uint8Array): string {
  const crypto =
    typeof process !== 'undefined' && process.getBuiltinModule?.('node:crypto');
  if (!crypto) throw new Error('Family intake requires a Node server');
  return crypto.createHash('sha256').update(value).digest('hex');
}
function key(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid family intake key');
}
type Selection = FamilyIntakeRequest & { intakeId: string };
type Decision =
  | { kind: 'assign'; learnerId: string; reason: string }
  | { kind: 'adopt'; learnerId: string; photoIntakeId: string };
/** Guardian-only original ownership before learner identity. Assignment never grades work. */
export class FamilyIntakeService extends WorkbookPhotoService {
  constructor(
    db: DatabaseInterface,
    authorize: LearnerAuthorizer,
    authorizeCatalog: CatalogAuthorizer,
    private readonly familyOptions: SubmissionServiceOptions,
    private readonly authorizeFamily: FamilyIntakeAuthorizer,
  ) {
    super(db, authorize, authorizeCatalog, familyOptions);
  }
  protected override createTransactionService(db: DatabaseInterface): this {
    return new FamilyIntakeService(
      db,
      this.authorize,
      this.authorizeCatalog,
      this.familyOptions,
      this.authorizeFamily,
    ) as this;
  }
  async authorizeFamilyIntake(
    request: FamilyIntakeRequest,
    action: Parameters<FamilyIntakeAuthorizer>[0]['action'] = 'education.family-intake.read',
  ) {
    this.assertServiceOpen();
    const context = getCurrentTenant();
    if (
      !context ||
      context.superAdminBypass ||
      context.tenantId !== request.tenantId ||
      context.userId !== request.actorUserId ||
      !request.tenantId ||
      !request.actorUserId ||
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: request.actorUserId,
        status: 'active',
      })) ||
      !(await this.db.get('users', {
        id: request.actorUserId,
        status: 'active',
      })) ||
      (await this.authorizeFamily({
        ...request,
        executor: this.db,
        action,
      })) !== true
    )
      throw new LearnerAuthorizationError();
  }
  private async familyRow(request: Selection) {
    await this.authorizeFamilyIntake(request);
    const row = await (
      await FamilyIntakeCollection.create({ db: this.db })
    ).get(
      { id: request.intakeId, tenantId: request.tenantId },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    return row;
  }
  private async familyDecisions(request: Selection) {
    return (
      await (
        await FamilyIntakeDecisionCollection.create({ db: this.db })
      ).list({
        where: { tenantId: request.tenantId, intakeId: request.intakeId },
        limit: 10000,
      })
    ).sort((a, b) => a.sequence - b.sequence);
  }
  private async lockFamily(request: Selection) {
    await this.db.query(
      'UPDATE family_intakes SET id=id WHERE id=? AND tenant_id=?',
      [request.intakeId, request.tenantId],
    );
  }
  private async appendFamily(
    request: Selection,
    requestKey: string,
    body: Decision,
  ) {
    return (
      await FamilyIntakeDecisionCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      tenantId: request.tenantId,
      intakeId: request.intakeId,
      actorUserId: request.actorUserId,
      requestKey,
      sequence: (await this.familyDecisions(request)).length + 1,
      bodyJson: canonical(body),
    });
  }
  async retainFamilyIntake(
    request: FamilyIntakeRequest & {
      itemId: string;
      source: FamilyIntakeSource;
      pages: readonly SubmissionPage[];
    },
  ): Promise<FamilyIntakeView> {
    return this.composeMutation(async (service) => {
      if (service.executorBorrowed)
        throw new Error('Family storage requires an owned transaction');
      await service.authorizeFamilyIntake(
        request,
        'education.family-intake.receive',
      );
      key(request.itemId);
      for (const value of [
        request.source?.sourceId,
        request.source?.sourceVersion,
        request.source?.deliveryKey,
      ])
        key(value);
      if (Buffer.byteLength(canonical(request.source)) > 128 * 1024)
        throw new Error('Family source provenance exceeds limit');
      if (request.source.evidence !== undefined) {
        if (
          !Array.isArray(request.source.evidence) ||
          request.source.evidence.length > 200
        )
          throw new Error('Invalid family source evidence');
        for (const evidence of request.source.evidence) {
          for (const value of [
            evidence.evidenceId,
            evidence.partId,
            evidence.mimeType,
          ])
            key(value);
          if (evidence.parentEvidenceId !== null)
            key(evidence.parentEvidenceId);
          if (
            typeof evidence.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(evidence.sha256)
          )
            throw new Error('Invalid family source evidence hash');
        }
      }
      // Persist the public provenance contract, never arbitrary adapter options.
      const source: FamilyIntakeSource = {
        sourceId: request.source.sourceId,
        sourceVersion: request.source.sourceVersion,
        deliveryKey: request.source.deliveryKey,
        ...(request.source.evidence
          ? {
              evidence: request.source.evidence.map((e) => ({
                evidenceId: e.evidenceId,
                partId: e.partId,
                parentEvidenceId: e.parentEvidenceId,
                mimeType: e.mimeType,
                sha256: e.sha256,
              })),
            }
          : {}),
      };
      service.validatePages(request.pages);
      if (
        request.pages.reduce((n, p) => n + p.data.length, 0) >
        100 * 1024 * 1024
      )
        throw new Error('Family intake exceeds total byte limit');
      // Serialize first-receipt races before consulting the unique receipt key.
      await service.db.query('UPDATE tenants SET id=id WHERE id=?', [
        request.tenantId,
      ]);
      const contentDigest = digest(
        canonical({
          source,
          pages: request.pages.map((p) => ({
            name: p.name,
            mimeType: p.mimeType,
            sha256: digest(p.data),
          })),
        }),
      );
      const collection = await FamilyIntakeCollection.create({
        db: service.db,
      });
      const prior = await collection.get(
        { tenantId: request.tenantId, itemId: request.itemId },
        { cache: false },
      );
      if (prior) {
        if (prior.contentDigest !== contentDigest)
          throw new Error('Family receipt retry content conflict');
        return service.getFamilyIntake({
          ...request,
          intakeId: String(prior.id),
        });
      }
      const actor = await service.db.get('users', { id: request.actorUserId });
      if (!actor?.profile_id) throw new LearnerAuthorizationError();
      const row = await collection.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        itemId: request.itemId,
        actorUserId: request.actorUserId,
        ownerProfileId: actor.profile_id,
        contentDigest,
        sourceJson: canonical(source),
      });
      const links = await FamilyIntakeAssetCollection.create({
        db: service.db,
      });
      for (const [position, page] of request.pages.entries()) {
        const asset = await service.storePage(request, actor.profile_id, page);
        await links.create({
          _insertOnly: true,
          tenantId: request.tenantId,
          intakeId: String(row.id),
          assetId: String(asset.id),
          name: page.name,
          mimeType: page.mimeType,
          sha256: digest(page.data),
          position,
        });
      }
      return service.getFamilyIntake({ ...request, intakeId: String(row.id) });
    });
  }
  async getFamilyIntake(request: Selection): Promise<FamilyIntakeView> {
    const row = await this.familyRow(request);
    const decisions = await this.familyDecisions(request);
    const assignment = decisions
      .map((d) => JSON.parse(d.bodyJson) as Decision)
      .findLast((d) => d.kind === 'assign');
    const adoption = decisions
      .map((d) => JSON.parse(d.bodyJson) as Decision)
      .find((d) => d.kind === 'adopt');
    const originals = await (
      await FamilyIntakeAssetCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, intakeId: request.intakeId },
      orderBy: 'position',
      limit: 100,
    });
    return {
      id: String(row.id),
      itemId: row.itemId,
      source: JSON.parse(row.sourceJson),
      revision: decisions.length,
      learnerId: assignment?.learnerId ?? null,
      photoIntakeId: adoption?.kind === 'adopt' ? adoption.photoIntakeId : null,
      originals: originals.map((o) => ({
        assetId: o.assetId,
        name: o.name,
        mimeType: o.mimeType,
        sha256: o.sha256,
      })),
    };
  }
  async listFamilyIntakes(
    request: FamilyIntakeRequest,
    options: { limit?: number; offset?: number } = {},
  ): Promise<FamilyIntakeView[]> {
    await this.authorizeFamilyIntake(request);
    const limit = options.limit ?? 20,
      offset = options.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error('Invalid family inbox page');
    const rows = await (
      await FamilyIntakeCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId },
      orderBy: 'createdAt DESC',
      limit,
      offset,
    });
    return Promise.all(
      rows.map((row) =>
        this.getFamilyIntake({ ...request, intakeId: String(row.id) }),
      ),
    );
  }
  async countFamilyIntakes(request: FamilyIntakeRequest): Promise<number> {
    await this.authorizeFamilyIntake(request);
    const rows = await this.db.query(
      'SELECT COUNT(*) AS total FROM family_intakes f WHERE f.tenant_id=? AND NOT EXISTS (SELECT 1 FROM workbook_photo_intakes p WHERE p.tenant_id=f.tenant_id AND p.family_intake_id=f.id)',
      [request.tenantId],
    );
    return Number(rows.rows[0]?.total ?? 0);
  }
  async getFamilyIntakeTimeline(request: Selection) {
    await this.familyRow(request);
    return (await this.familyDecisions(request)).map((d) => ({
      id: String(d.id),
      revision: d.sequence,
      actorUserId: d.actorUserId,
      requestKey: d.requestKey,
      decision: JSON.parse(d.bodyJson) as Decision,
    }));
  }
  async readFamilyIntakeOriginal(request: Selection & { assetId: string }) {
    const row = await this.familyRow(request);
    const view = await this.getFamilyIntake(request);
    const original = view.originals.find((o) => o.assetId === request.assetId);
    if (!original) throw new LearnerAuthorizationError();
    return withPrivateAssetAccess(
      {
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        ownerProfileId: row.ownerProfileId,
        assetIds: [request.assetId],
      },
      async () => {
        const runtime = await this.assets();
        const asset = await runtime.collection.get(
          {
            id: request.assetId,
            tenantId: request.tenantId,
            ownerProfileId: row.ownerProfileId,
          },
          { cache: false },
        );
        if (asset?.accessMode !== 'private')
          throw new LearnerAuthorizationError();
        const data = await runtime.store.read(asset);
        if (digest(data) !== original.sha256)
          throw new Error('Retained family original integrity mismatch');
        return { data, mimeType: original.mimeType };
      },
    );
  }
  async assignFamilyIntake(
    request: Selection & {
      learnerId: string;
      guardianRelationshipId: string;
      requestKey: string;
      expectedRevision: number;
      reason: string;
    },
  ): Promise<FamilyIntakeView> {
    return this.composeMutation(async (service) => {
      await service.authorizeFamilyIntake(
        request,
        'education.family-intake.assign',
      );
      await service.lockFamily(request);
      await service.requireActor(request, 'education.learner.plan');
      key(request.requestKey);
      key(request.reason);
      const view = await service.getFamilyIntake(request);
      const body: Decision = {
        kind: 'assign',
        learnerId: request.learnerId,
        reason: request.reason,
      };
      const prior = (await service.familyDecisions(request)).find(
        (d) => d.requestKey === request.requestKey,
      );
      if (prior) {
        if (prior.bodyJson !== canonical(body))
          throw new Error('Family decision retry content conflict');
        return view;
      }
      if (view.photoIntakeId)
        throw new Error('Adopted family intake cannot be retargeted');
      if (
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision !== view.revision
      )
        throw new Error('Family intake revision conflict');
      await service.appendFamily(request, request.requestKey, body);
      return service.getFamilyIntake(request);
    });
  }
  /** Freeze the explicit assignment and borrow exact originals; no capture or grading. */
  async adoptFamilyIntake(
    request: Selection & {
      learnerId: string;
      guardianRelationshipId: string;
      requestKey: string;
      expectedRevision: number;
    },
  ): Promise<FamilyIntakeView> {
    return this.composeMutation(async (service) => {
      await service.authorizeFamilyIntake(
        request,
        'education.family-intake.assign',
      );
      await service.lockFamily(request);
      await service.requireActor(request, 'education.learner.plan');
      key(request.requestKey);
      const view = await service.getFamilyIntake(request);
      const prior = (await service.familyDecisions(request)).find(
        (d) => d.requestKey === request.requestKey,
      );
      if (prior) {
        const body = JSON.parse(prior.bodyJson) as Decision;
        if (body.kind !== 'adopt' || body.learnerId !== request.learnerId)
          throw new Error('Family decision retry content conflict');
        return view;
      }
      if (view.photoIntakeId || view.learnerId !== request.learnerId)
        throw new Error('Family intake assignment mismatch');
      if (
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision !== view.revision
      )
        throw new Error('Family intake revision conflict');
      const row = await service.familyRow(request);
      // Verify every retained hash before exposing it through a learner-bound join.
      for (const original of view.originals)
        await service.readFamilyIntakeOriginal({
          ...request,
          assetId: original.assetId,
        });
      const photoIntakeId = globalThis.crypto.randomUUID();
      await service.appendFamily(request, request.requestKey, {
        kind: 'adopt',
        learnerId: request.learnerId,
        photoIntakeId,
      });
      const photo = await (
        await WorkbookPhotoIntakeCollection.create({ db: service.db })
      ).create({
        id: photoIntakeId,
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        familyIntakeId: request.intakeId,
        itemId: row.itemId,
        actorUserId: row.actorUserId,
        contentDigest: row.contentDigest,
      });
      const links = await WorkbookPhotoAssetCollection.create({
        db: service.db,
      });
      for (const [position, original] of view.originals.entries())
        await links.create({
          _insertOnly: true,
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          intakeId: String(photo.id),
          ...original,
          position,
        });

      return service.getFamilyIntake(request);
    });
  }
}
