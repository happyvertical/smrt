import { withPrivateAssetAccess } from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CatalogAuthorizer } from './catalog-service.js';
import { familyAdoptionOwner } from './family-intake-models.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  type LearnerRequest,
} from './learner-service.js';
import type {
  SubmissionPage,
  SubmissionServiceOptions,
} from './submission-service.js';
import type {
  WorkbookAssessment,
  WorkbookAssistance,
} from './workbook-contracts.js';
import { WorkbookCollection } from './workbook-models.js';
import {
  validateWorkbookPhotoIdentification,
  type WorkbookPhotoIdentification,
  type WorkbookPhotoIntakeView,
  type WorkbookPhotoProposal,
  type WorkbookPhotoWorkbookView,
} from './workbook-photo-contracts.js';
import {
  WorkbookContextRevisionCollection,
  WorkbookPhotoAssetCollection,
  WorkbookPhotoDecisionCollection,
  WorkbookPhotoIntakeCollection,
} from './workbook-photo-models.js';
import { WorkbookService } from './workbook-service.js';

/** Internal bridge capability, intentionally absent from package exports. */
export const preservePhotoProposal = Symbol('preserveWorkbookPhotoProposal');
type PhotoRequest = LearnerRequest & { intakeId: string };
/** Hashing runs only inside authorized server operations; loading the package
 * root must keep Node built-ins outside the browser dependency graph. */
function createHash(algorithm: 'sha256') {
  const crypto =
    typeof process !== 'undefined' && process.getBuiltinModule?.('node:crypto');
  if (!crypto) throw new Error('Workbook photo intake requires a Node server');
  return crypto.createHash(algorithm);
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const hash = (v: unknown): string =>
  createHash('sha256').update(canonical(v)).digest('hex');
const sha = (v: Uint8Array): string =>
  createHash('sha256').update(v).digest('hex');
function key(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error('Invalid photo request key');
}
type Decision =
  | {
      type: 'resolve';
      identification: WorkbookPhotoIdentification;
      activity: WorkbookPhotoIntakeView['activity'];
    }
  | {
      type: 'proposal';
      proposal: WorkbookPhotoProposal;
      provenance: Record<string, unknown>;
    }
  | { type: 'capture'; submissionId: string; requestDigest: string };
/** Server-owned intake before assignment. All originals survive ingestion scratch expiry. */
export class WorkbookPhotoService extends WorkbookService {
  constructor(
    db: DatabaseInterface,
    authorize: LearnerAuthorizer,
    authorizeCatalog: CatalogAuthorizer,
    private readonly photoOptions: SubmissionServiceOptions & {
      workbookVocabulary?: WorkbookAssessment['vocabulary'];
    },
  ) {
    super(db, authorize, authorizeCatalog, photoOptions);
  }
  protected override createTransactionService(db: DatabaseInterface): this {
    return new WorkbookPhotoService(
      db,
      this.authorize,
      this.authorizeCatalog,
      this.photoOptions,
    ) as this;
  }
  /** Only an exact adopted receipt can bridge its immutable family source scope. */
  async assertWorkbookPhotoScope(
    request: LearnerRequest,
    scope: {
      tenantId: string;
      actorId: string;
      confidentialScopeId: string;
    },
    itemId: string,
  ): Promise<void> {
    if (
      scope.tenantId !== request.tenantId ||
      scope.actorId !== request.actorUserId
    )
      throw new LearnerAuthorizationError();
    if (scope.confidentialScopeId === request.learnerId) return;
    if (scope.confidentialScopeId !== `family-intake:${request.tenantId}`)
      throw new LearnerAuthorizationError();
    const view = await this.getWorkbookPhotoIntakeByItem({
      ...request,
      itemId,
    });
    const photo = await this.db.get('workbook_photo_intakes', {
      id: view.id,
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      item_id: itemId,
    });
    if (
      !photo?.family_intake_id ||
      !(await this.db.get('family_intakes', {
        id: photo.family_intake_id,
        tenant_id: request.tenantId,
        item_id: itemId,
      }))
    )
      throw new LearnerAuthorizationError();
    await familyAdoptionOwner(
      this.db,
      photo as Parameters<typeof familyAdoptionOwner>[1],
    );
  }
  async authorizePhotoIntake(request: LearnerRequest): Promise<void> {
    await this.requireActor(request, 'education.learner.submit');
  }
  private async lockPhoto(request: LearnerRequest) {
    await this.db.query(
      'UPDATE learners SET id=id WHERE id=? AND tenant_id=?',
      [request.learnerId, request.tenantId],
    );
  }
  private async receipt(request: PhotoRequest) {
    const learner = await this.requireActor(request, 'education.learner.read');
    const row = await (
      await WorkbookPhotoIntakeCollection.create({ db: this.db })
    ).get(
      {
        id: request.intakeId,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
      },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    if (
      learner.userId === request.actorUserId &&
      row.actorUserId !== request.actorUserId
    ) {
      const resolution = (await this.decisions(request))
        .map((r) => JSON.parse(r.bodyJson) as Decision)
        .filter(
          (d): d is Extract<Decision, { type: 'resolve' }> =>
            d.type === 'resolve',
        )
        .at(-1);
      const source = await this.workbookPhotoSource(request, {
        intakeItemId: row.itemId,
      });
      if (
        !['lesson', 'work'].includes(resolution?.identification.kind ?? '') ||
        !resolution?.activity ||
        !source.released
      )
        throw new LearnerAuthorizationError();
    }
    return row;
  }
  private async decisions(request: PhotoRequest) {
    return (
      await (
        await WorkbookPhotoDecisionCollection.create({ db: this.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          intakeId: request.intakeId,
        },
        limit: 10000,
      })
    ).sort((a, b) => a.sequence - b.sequence);
  }
  private async append(
    request: PhotoRequest,
    requestKey: string,
    body: Decision,
  ) {
    key(requestKey);
    const rows = await this.decisions(request);
    const existing = rows.find((r) => r.requestKey === requestKey);
    const bodyJson = canonical(body);
    if (existing) {
      if (existing.bodyJson !== bodyJson)
        throw new Error('Photo decision retry content conflict');
      return existing;
    }
    return (
      await WorkbookPhotoDecisionCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      intakeId: request.intakeId,
      requestKey,
      actorUserId: request.actorUserId,
      bodyJson,
      sequence: rows.length + 1,
    });
  }
  async retainWorkbookPhotoIntake(
    request: LearnerRequest & {
      itemId: string;
      pages: readonly SubmissionPage[];
    },
  ): Promise<WorkbookPhotoIntakeView> {
    return this.composeMutation(async (service) => {
      if (service.executorBorrowed)
        throw new Error('Photo storage requires an owned transaction');
      const learner = await service.requireActor(
        request,
        'education.learner.submit',
      );
      await service.lockPhoto(request);
      key(request.itemId);
      service.validatePages(request.pages);
      if (
        request.pages.reduce((n, p) => n + p.data.length, 0) >
        100 * 1024 * 1024
      )
        throw new Error('Photo intake exceeds total byte limit');
      const contentDigest = hash(
        request.pages.map((p) => ({
          name: p.name,
          mimeType: p.mimeType,
          sha256: sha(p.data),
        })),
      );
      const collection = await WorkbookPhotoIntakeCollection.create({
        db: service.db,
      });
      const prior = await collection.get(
        { tenantId: request.tenantId, itemId: request.itemId },
        { cache: false },
      );
      if (prior) {
        if (
          prior.learnerId !== request.learnerId ||
          prior.contentDigest !== contentDigest
        )
          throw new Error('Photo intake retry content conflict');
        return service.getWorkbookPhotoIntake({
          ...request,
          intakeId: String(prior.id),
        });
      }
      const row = await collection.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        itemId: request.itemId,
        actorUserId: request.actorUserId,
        contentDigest,
      });
      const links = await WorkbookPhotoAssetCollection.create({
        db: service.db,
      });
      for (const [position, page] of request.pages.entries()) {
        const asset = await service.storePage(request, learner.profileId, page);
        await links.create({
          _insertOnly: true,
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          intakeId: String(row.id),
          assetId: String(asset.id),
          name: page.name,
          mimeType: page.mimeType,
          sha256: sha(page.data),
          position,
        });
      }
      return service.getWorkbookPhotoIntake({
        ...request,
        intakeId: String(row.id),
      });
    });
  }
  async getWorkbookPhotoIntake(
    request: PhotoRequest,
  ): Promise<WorkbookPhotoIntakeView> {
    const row = await this.receipt(request);
    const decisionRows = await this.decisions(request);
    const decisions = decisionRows.map(
      (r) => JSON.parse(r.bodyJson) as Decision,
    );
    const resolutionRow = decisionRows.findLast(
      (r) => (JSON.parse(r.bodyJson) as Decision).type === 'resolve',
    );
    const resolution = resolutionRow
      ? (JSON.parse(resolutionRow.bodyJson) as Extract<
          Decision,
          { type: 'resolve' }
        >)
      : undefined;
    let workbookId: string | null = null;
    if (resolutionRow) {
      const context = await (
        await WorkbookContextRevisionCollection.create({ db: this.db })
      ).get(
        {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          decisionId: String(resolutionRow.id),
        },
        { cache: false },
      );
      if (context) {
        const book = await (
          await WorkbookCollection.create({ db: this.db })
        ).get(
          {
            id: context.workbookId,
            tenantId: request.tenantId,
            learnerId: request.learnerId,
          },
          { cache: false },
        );
        if (!book) throw new LearnerAuthorizationError();
        workbookId = String(book.id);
      }
    }
    const proposal = decisions
      .filter(
        (d): d is Extract<Decision, { type: 'proposal' }> =>
          d.type === 'proposal',
      )
      .at(-1);
    const capture = decisions.find(
      (d): d is Extract<Decision, { type: 'capture' }> => d.type === 'capture',
    );
    const links = await (
      await WorkbookPhotoAssetCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        intakeId: request.intakeId,
      },
      limit: 100,
    });
    return {
      id: String(row.id),
      itemId: row.itemId,
      workbookId,
      learnerId: row.learnerId,
      status: capture
        ? 'captured'
        : resolution && resolution.identification.kind !== 'uncertain'
          ? 'resolved'
          : 'pending',
      identification: resolution?.identification ?? null,
      proposal: proposal?.proposal ?? null,
      activity: resolution?.activity
        ? await this.getWorkbookActivity({
            ...request,
            activityId: resolution.activity.id,
          })
        : null,
      submissionId: capture?.submissionId ?? null,
      originals: links
        .sort((a, b) => a.position - b.position)
        .map((l) => ({
          assetId: l.assetId,
          name: l.name,
          mimeType: l.mimeType,
          sha256: l.sha256,
        })),
    };
  }
  /** Exact receipt lookup for processing/retry; inbox pagination grants no authority. */
  async getWorkbookPhotoIntakeByItem(
    request: LearnerRequest & { itemId: string },
  ): Promise<WorkbookPhotoIntakeView> {
    await this.requireActor(request, 'education.learner.read');
    key(request.itemId);
    const row = await (
      await WorkbookPhotoIntakeCollection.create({ db: this.db })
    ).get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        itemId: request.itemId,
      },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    // Reuse the full current actor and private-origin/release visibility boundary.
    return this.getWorkbookPhotoIntake({
      ...request,
      intakeId: String(row.id),
    });
  }
  async listWorkbookPhotoIntakes(
    request: LearnerRequest,
    options: { newestFirst?: boolean } = {},
  ): Promise<WorkbookPhotoIntakeView[]> {
    await this.requireActor(request, 'education.learner.read');
    const rows = await (
      await WorkbookPhotoIntakeCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: request.learnerId },
      limit: 1000,
      orderBy: options.newestFirst === true ? 'createdAt DESC' : 'createdAt',
    });
    const visible: WorkbookPhotoIntakeView[] = [];
    for (const row of rows) {
      try {
        visible.push(
          await this.getWorkbookPhotoIntake({
            ...request,
            intakeId: String(row.id),
          }),
        );
      } catch (error) {
        if (!(error instanceof LearnerAuthorizationError)) throw error;
      }
    }
    return visible;
  }
  /** Authorized contextual catalog, including books identified from covers alone. */
  async listWorkbookPhotoWorkbooks(
    request: LearnerRequest,
  ): Promise<WorkbookPhotoWorkbookView[]> {
    await this.requireActor(request, 'education.learner.read');
    const books = await (await WorkbookCollection.create({ db: this.db })).list(
      {
        where: { tenantId: request.tenantId, learnerId: request.learnerId },
        limit: 1000,
      },
    );
    const contexts = await (
      await WorkbookContextRevisionCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: request.learnerId },
      limit: 10000,
      orderBy: 'createdAt',
    });
    return books.map((book) => {
      const metadata = Object.assign(
        {},
        ...contexts
          .filter((c) => c.workbookId === String(book.id))
          .map((c) => JSON.parse(c.metadataJson).identification?.workbook),
      );
      return {
        id: String(book.id),
        workbookKey: book.workbookKey,
        title: book.title,
        edition: book.edition,
        ...(metadata?.publisher ? { publisher: metadata.publisher } : {}),
        ...(metadata?.isbn ? { isbn: metadata.isbn } : {}),
      };
    });
  }
  async readWorkbookPhotoOriginal(
    request: PhotoRequest & { assetId: string },
  ): Promise<{ data: Uint8Array; mimeType: string }> {
    const view = await this.getWorkbookPhotoIntake(request);
    const original = view.originals.find((o) => o.assetId === request.assetId);
    if (!original) throw new LearnerAuthorizationError();
    const learner = await this.requireActor(request, 'education.learner.read');
    let ownerProfileId = learner.profileId;
    const photo = await this.db.get('workbook_photo_intakes', {
      id: request.intakeId,
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
    });
    if (photo?.family_intake_id) {
      await familyAdoptionOwner(
        this.db,
        photo as Parameters<typeof familyAdoptionOwner>[1],
      );
      const family = await this.db.get('family_intakes', {
        id: photo.family_intake_id,
        tenant_id: request.tenantId,
        item_id: photo.item_id,
      });
      if (
        !family ||
        !(await this.db.get('family_intake_assets', {
          tenant_id: request.tenantId,
          intake_id: family.id,
          asset_id: request.assetId,
          sha256: original.sha256,
          name: original.name,
          mime_type: original.mimeType,
        }))
      )
        throw new LearnerAuthorizationError();
      ownerProfileId = family.owner_profile_id;
    }
    return withPrivateAssetAccess(
      {
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        ownerProfileId,
        assetIds: [request.assetId],
      },
      async () => {
        const runtime = await this.assets();
        const asset = await runtime.collection.get(
          {
            id: request.assetId,
            tenantId: request.tenantId,
            ownerProfileId,
          },
          { cache: false },
        );
        if (asset?.accessMode !== 'private')
          throw new LearnerAuthorizationError();
        const data = await runtime.store.read(asset);
        if (sha(data) !== original.sha256)
          throw new Error('Retained photo integrity mismatch');
        return { data, mimeType: original.mimeType };
      },
    );
  }
  async resolveWorkbookPhotoIntake(
    request: PhotoRequest & {
      requestKey: string;
      identification: WorkbookPhotoIdentification;
    },
  ): Promise<WorkbookPhotoIntakeView> {
    return this.mutate(async (service) => {
      await service.requireActor(request, 'education.learner.plan');
      await service.lockPhoto(request);
      return service.resolvePhoto(request);
    });
  }
  private async resolvePhoto(
    request: PhotoRequest & {
      requestKey: string;
      identification: WorkbookPhotoIdentification;
    },
    action:
      | 'education.learner.plan'
      | 'education.learner.submit' = 'education.learner.plan',
  ): Promise<WorkbookPhotoIntakeView> {
    const current = await this.getWorkbookPhotoIntake(request);
    validateWorkbookPhotoIdentification(request.identification);
    const existing = (await this.decisions(request)).find(
      (r) => r.requestKey === request.requestKey,
    );
    if (existing) {
      const body = JSON.parse(existing.bodyJson);
      if (
        body.type !== 'resolve' ||
        canonical(body.identification) !== canonical(request.identification)
      )
        throw new Error('Photo decision retry content conflict');
      return current;
    }
    if (current.submissionId)
      throw new Error('Captured photo identity is immutable');
    let activity: WorkbookPhotoIntakeView['activity'] = null;
    let workbookId: string | null = null;
    if (request.identification.kind === 'work')
      activity = await this.resolveUnfiledWorkbookActivityInScope(
        request,
        action,
      );
    const identity = request.identification.workbook;
    if (identity && request.identification.kind !== 'uncertain') {
      const books = await WorkbookCollection.create({ db: this.db });
      let book = await books.get(
        {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          workbookKey: identity.workbookKey,
        },
        { cache: false },
      );
      if (
        book &&
        (book.title !== identity.title ||
          book.edition !== (identity.edition ?? ''))
      )
        throw new Error('Workbook key already names another title or edition');
      book ??= await books.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        workbookKey: identity.workbookKey,
        title: identity.title,
        edition: identity.edition ?? '',
      });
      workbookId = String(book.id);
      if (
        request.identification.kind === 'lesson' &&
        request.identification.activity
      ) {
        activity = await this.resolveWorkbookActivityInScope(
          {
            ...request,
            ...identity,
            ...request.identification.activity,
          },
          action,
        );
      }
    }
    const decision = await this.append(request, request.requestKey, {
      type: 'resolve',
      identification: request.identification,
      activity,
    });
    if (workbookId)
      await (
        await WorkbookContextRevisionCollection.create({ db: this.db })
      ).create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        workbookId,
        decisionId: String(decision.id),
        metadataJson: JSON.stringify({
          identification: request.identification,
          intakeId: request.intakeId,
        }),
      });
    return this.getWorkbookPhotoIntake(request);
  }
  /** Trusted server bridge only: proposal provenance must come from the public ingestion snapshot. */
  async [preservePhotoProposal](
    request: PhotoRequest & {
      requestKey: string;
      proposal: WorkbookPhotoProposal;
      provenance: Record<string, unknown>;
      sourceHashes: string[];
      allowAutomaticResolution?: boolean;
    },
  ): Promise<WorkbookPhotoIntakeView> {
    return this.mutate(async (service) => {
      await service.authorizePhotoIntake(request);
      await service.lockPhoto(request);
      const view = await service.getWorkbookPhotoIntake(request);
      if (
        JSON.stringify(view.originals.map((o) => o.sha256)) !==
        JSON.stringify(request.sourceHashes)
      )
        throw new Error('Photo proposal source mismatch');
      validateWorkbookPhotoIdentification(request.proposal.identification);
      if (
        !['confident', 'uncertain'].includes(request.proposal.confidence) ||
        !Array.isArray(request.proposal.identityEvidence) ||
        request.proposal.identityEvidence.some(
          (e) => typeof e !== 'string' || e.length > 2000,
        ) ||
        typeof request.proposal.lessonEvidence !== 'string'
      )
        throw new Error('Invalid photo proposal');
      await service.append(request, request.requestKey, {
        type: 'proposal',
        proposal: request.proposal,
        provenance: request.provenance,
      });
      // Provider output never overrides a human decision or a captured identity.
      if (view.identification || view.submissionId)
        return service.getWorkbookPhotoIntake(request);
      const identification = structuredClone(request.proposal.identification);
      const book = identification.workbook;
      // Material/completion confidence is independent of bibliographic identity.
      // Existing book/lesson matching below remains unchanged and cannot merge work.
      if (
        request.allowAutomaticResolution === true &&
        request.proposal.confidence === 'confident' &&
        identification.kind === 'work'
      )
        return service.resolvePhoto(
          {
            ...request,
            requestKey: `auto:${hash(request.requestKey)}`,
            identification,
          },
          'education.learner.submit',
        );
      if (
        request.allowAutomaticResolution !== true ||
        request.proposal.confidence !== 'confident' ||
        identification.kind === 'uncertain' ||
        !book ||
        !request.proposal.identityEvidence.length
      )
        return service.getWorkbookPhotoIntake(request);
      const printed = request.proposal.identityEvidence
        .join(' ')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const contains = (value: string) =>
        printed.includes(
          value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
        );
      const candidates = await service.listWorkbookPhotoWorkbooks(request);
      const matches = candidates.filter(
        (candidate) =>
          candidate.title === book.title &&
          candidate.edition === (book.edition ?? ''),
      );
      const candidate = matches.length === 1 ? matches[0] : undefined;
      if (
        request.proposal.workbookId &&
        (!candidate || candidate.id !== request.proposal.workbookId)
      )
        return service.getWorkbookPhotoIntake(request);
      const normalizeIsbn = (value: string) =>
        value.replace(/[^0-9X]/gi, '').toUpperCase();
      const existingMatch =
        !!candidate &&
        !!candidate.publisher?.trim() &&
        !!book.edition?.trim() &&
        contains(book.title) &&
        contains(book.edition) &&
        (!book.publisher || book.publisher === candidate.publisher) &&
        (!book.isbn ||
          !candidate.isbn ||
          normalizeIsbn(book.isbn) === normalizeIsbn(candidate.isbn));
      const normalizedIsbn = book.isbn ? normalizeIsbn(book.isbn) : undefined;
      const strongIsbn =
        normalizedIsbn &&
        /^(?:[0-9]{13}|[0-9]{9}[0-9X])$/.test(normalizedIsbn) &&
        printed.replace(/[^0-9x]/g, '').includes(normalizedIsbn.toLowerCase());
      if (existingMatch) {
        book.workbookKey = candidate.workbookKey;
        book.publisher ??= candidate.publisher;
        book.isbn ??= candidate.isbn;
      } else if (strongIsbn && !request.proposal.workbookId) {
        book.workbookKey = `isbn:${normalizedIsbn}`;
      } else {
        if (
          request.proposal.workbookId ||
          !book.publisher?.trim() ||
          !book.edition?.trim() ||
          !contains(book.publisher) ||
          !contains(book.title) ||
          !contains(book.edition)
        )
          return service.getWorkbookPhotoIntake(request);
        // A conflicting title/edition candidate requires a guardian to select
        // the physical copy, even when this page names another publisher.
        if (matches.length) return service.getWorkbookPhotoIntake(request);
        book.workbookKey = `printed:${hash([book.publisher, book.title, book.edition])}`;
      }
      if (
        identification.kind === 'lesson' &&
        (!request.proposal.lessonEvidence.trim() ||
          /^(?:(?:page|p\.?)\s*)?\d+[a-z]?(?:\s*[-–]\s*\d+[a-z]?)?$/i.test(
            request.proposal.lessonEvidence.trim(),
          ) ||
          !identification.activity?.pageKey.startsWith('lesson:'))
      )
        return service.getWorkbookPhotoIntake(request);
      if (identification.kind === 'lesson' && identification.activity) {
        const lessonLabel = request.proposal.lessonEvidence
          .normalize('NFKC')
          .trim()
          .replace(/\s+/g, ' ');
        identification.activity = {
          pageKey: `lesson:${hash(lessonLabel.toLowerCase())}`,
          pageLabel: lessonLabel,
        };
      }
      return service.resolvePhoto(
        {
          ...request,
          requestKey: `auto:${hash(request.requestKey)}`,
          identification,
        },
        'education.learner.submit',
      );
    });
  }
  /** Exact authorized receipt history; filing does not move the stable work unit. */
  async getWorkbookPhotoTimeline(
    request: PhotoRequest & {
      limit?: number;
      cursor?: string;
      revisionId?: string;
    },
  ) {
    const intake = await this.getWorkbookPhotoIntake(request);
    if (!intake.activity || !intake.submissionId)
      throw new Error('Photo work has not been captured');
    return this.getWorkbookTimeline({
      ...request,
      activityId: intake.activity.id,
    });
  }
  async captureWorkbookPhotoIntake(
    request: PhotoRequest & {
      requestKey: string;
      assistance?: WorkbookAssistance;
      previousSubmissionId?: string;
      completedWork?: boolean;
    },
  ) {
    return this.withTransaction(async (service) => {
      if (service.executorBorrowed)
        throw new Error('Photo capture requires an owned transaction');
      await service.authorizePhotoIntake(request);
      await service.lockPhoto(request);
      const view = await service.getWorkbookPhotoIntake(request);
      if (
        !view.activity ||
        !['lesson', 'work'].includes(view.identification?.kind ?? '')
      )
        throw new Error('Photo intake has no captured-work classification');
      if (
        view.identification?.workState !== 'completed' &&
        request.completedWork !== true
      )
        throw new Error(
          'Blank or unknown work requires intentional completed-work submission',
        );
      const requestDigest = hash([
        request.requestKey,
        request.assistance ?? 'unknown',
        request.previousSubmissionId ?? null,
        request.completedWork ?? false,
      ]);
      const captured = (await service.decisions(request))
        .map((r) => JSON.parse(r.bodyJson) as Decision)
        .find((d) => d.type === 'capture');
      if (
        captured &&
        captured.type === 'capture' &&
        captured.requestDigest !== requestDigest
      )
        throw new Error('Photo capture retry content conflict');
      const pages: SubmissionPage[] = [];
      for (const original of view.originals) {
        const file = await service.readWorkbookPhotoOriginal({
          ...request,
          assetId: original.assetId,
        });
        pages.push({
          name: original.name,
          mimeType: original.mimeType as SubmissionPage['mimeType'],
          data: Buffer.from(file.data),
        });
      }
      const attempt = await service.captureWorkbookWork({
        ...request,
        activityId: view.activity.id,
        intakeItemId: view.itemId,
        pages,
      });
      await service.mutate((s) =>
        s.append(request, `capture:${hash(request.requestKey)}`, {
          type: 'capture',
          submissionId: attempt.submissionId,
          requestDigest,
        }),
      );
      return attempt;
    });
  }
}
