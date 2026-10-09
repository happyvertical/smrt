import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPDFReader } from '@happyvertical/pdf';
import { expect, test } from 'vitest';
import { CREATE } from '../reference/handlers.js';
import { ReferenceReviewHost } from '../reference/review-host.js';
import { extractAnalysis } from '../src/extraction.js';
import { extractWithProviders } from '../src/extraction-providers.js';
import {
  type EmailIntakeSnapshot,
  EmailSourceAdapter,
  type SourceBinding,
  WatchFolderSourceAdapter,
} from '../src/sources/index.js';
import { embeddedPDF } from '../src/test-support/extraction-fixtures.js';
import { EVALUATION_SCOPE } from './reference-case.js';

// Provider quality is not measured here. A deterministic proposal boundary proves
// real source adapters, real PDF parsing and maintained authorization/effect wiring.
test.each([
  'watch',
  'email',
] as const)('%s owning source preserves PDF through reference review, Content draft and replay', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-source-flow-'));
  const configuration = {
    configurationRevision: 'source-composition1',
    limits: {
      maxBytes: 1000000,
      maxPages: 10,
      maxPixels: 1000000,
      maxOutputBytes: 100000,
      timeoutMs: 15000,
      maxTokens: 1024,
      workerHeapMb: 256,
    },
  };
  const pdf = embeddedPDF('Reference source composition');
  const reader = await getPDFReader({ provider: 'unpdf', enableOCR: false });
  let providerCalls = 0;
  const host = await ReferenceReviewHost.provision(root, {
    proposalPolicy: {
      version: 'source-policy1',
      providers: ['fixture'],
      maxBytes: 20000,
      leaseMs: 60000,
    },
    proposals: {
      version: 'source-config1',
      promptVersion: 'source-prompt1',
      limits: {
        maxHandlers: 2,
        maxCandidates: 4,
        maxSuggestions: 2,
        maxInputBytes: 20000,
        maxOutputBytes: 20000,
        maxQueryLength: 1000,
        timeoutMs: 10000,
      },
      generator: {
        identity: {
          provider: 'fixture',
          model: 'deterministic-not-quality',
          version: '1',
        },
        generate: async (input) => {
          providerCalls++;
          const original = input.evidence.find(
            (part) => part.mediaType === 'application/pdf',
          );
          if (!original) throw Error('PDF missing');
          expect(original.segments[0].text).toContain(
            'Reference source composition',
          );
          return {
            completion: 'complete',
            output: {
              outcome: 'proposals',
              splits: [],
              suggestions: [
                {
                  handlerId: CREATE,
                  handlerVersion: '1',
                  args: {
                    title: 'Source composition',
                    body: 'Reference source composition',
                  },
                  evidence: [
                    {
                      evidenceId: original.evidenceId,
                      location: original.segments[0].location,
                    },
                  ],
                  alternatives: [],
                  missingFields: [],
                  explanation: 'Deterministic contract fixture',
                },
              ],
            },
          };
        },
      },
    },
    extraction: {
      configuration,
      run: (service, lease) =>
        extractAnalysis(
          service,
          lease,
          {
            extract: (request) =>
              extractWithProviders(request, {
                pdf: {
                  client: reader,
                  identity: {
                    provider: 'unpdf',
                    model: 'embedded-text',
                    version: '0.65.9',
                  },
                },
              }),
          },
          configuration,
        ),
    },
  });
  try {
    const { service, handlers, operations } =
      await host.service(EVALUATION_SCOPE);
    const now = Date.now();
    const binding: SourceBinding = {
      enabled: true,
      service,
      sourceId: `evaluation-${kind}`,
      sourceVersion: '1',
      capturedCeiling: {
        execution: {
          principalId: '33333333-3333-4333-8333-333333333333',
          permissions: ['contents.create', 'contents.addAsset'],
          handlers: handlers.map((handler) => handler.id),
          operations,
        },
      },
      retention: {
        version: '1',
        expiresAt: new Date(now + 86400000),
        replayUntil: new Date(now + 172800000),
        acceptAfter: new Date(now - 60000),
      },
      limits: {
        maxBytes: 1000000,
        maxParts: 10,
        maxAttempts: 3,
        leaseMs: 60000,
        maxOutputBytes: 100000,
      },
      allowedMediaTypes: ['application/json', 'application/pdf'],
    };
    let itemId: string | undefined;
    if (kind === 'watch') {
      const directory = join(root, 'watch');
      mkdirSync(directory);
      writeFileSync(join(directory, 'source.pdf'), pdf);
      let clock = now;
      const adapter = new WatchFolderSourceAdapter({
        binding,
        directory,
        stabilityMs: 1,
        now: () => clock,
      });
      for (let attempt = 0; attempt < 4 && !itemId; attempt++) {
        const results = await adapter.poll();
        clock += 2;
        for (const row of results)
          if (row.result.kind === 'accepted' || row.result.kind === 'duplicate')
            itemId = row.result.itemId;
      }
      expect(itemId).toBeDefined();
      expect(await adapter.poll()).toEqual([]);
    } else {
      const raw = join(root, 'message.eml'),
        snapshotPath = join(root, 'snapshot.json');
      writeFileSync(
        raw,
        `From: source@example.test\r\nTo: intake@example.test\r\nMessage-ID: <source@example.test>\r\nDate: ${new Date(now).toUTCString()}\r\nSubject: Source composition\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="case"\r\n\r\n--case\r\nContent-Type: text/plain\r\n\r\nRetain the attached document.\r\n--case\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="source.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf.toString('base64')}\r\n--case--\r\n`,
      );
      execFileSync(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          fileURLToPath(new URL('./email-transport.mjs', import.meta.url)),
          raw,
          snapshotPath,
        ],
        { stdio: 'pipe', timeout: 30000 },
      );
      const decoded = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      const snapshot: EmailIntakeSnapshot = {
        ...decoded.snapshot,
        attachments: decoded.snapshot.attachments.map(
          (part: { bytes: number[] }) => ({
            ...part,
            bytes: Uint8Array.from(part.bytes),
          }),
        ),
      };
      let acknowledgements = 0;
      const adapter = new EmailSourceAdapter({
        binding,
        accountId: snapshot.accountId,
        readMessage: async () => snapshot,
        acknowledge: async () => {
          acknowledgements++;
        },
      });
      const delivery = {
        locator: 'INBOX:7:42',
        revision: '1',
        checkpoint: '42',
      };
      const first = await adapter.receive(delivery);
      expect(first.kind).toBe('accepted');
      if (first.kind !== 'accepted') throw Error('Email rejected');
      itemId = first.itemId;
      expect(await adapter.receive(delivery)).toMatchObject({
        kind: 'duplicate',
        itemId,
      });
      expect(acknowledgements).toBe(2);
    }
    if (!itemId) throw Error('Receipt missing');
    const originals = await service.getEvidence(itemId);
    const original = originals.find(
      (part) => part.mediaType === 'application/pdf',
    );
    if (!original) throw Error('PDF missing');
    expect(
      Buffer.from(await service.readEvidence(itemId, original.id)),
    ).toEqual(pdf);
    await host.process(EVALUATION_SCOPE, itemId);
    const view = await host.load(EVALUATION_SCOPE, itemId);
    expect(view.reviews.actions).toEqual([]);
    expect(providerCalls).toBe(1);
    if (!view.analysis) throw Error('Analysis missing');
    const preview = await host.preview(EVALUATION_SCOPE, {
      itemId,
      attemptId: view.analysis.attemptId,
      index: 0,
      requestId: 'source-preview',
    });
    if (preview[0]?.kind !== 'operation') throw Error('Operation missing');
    const review = preview[0].review;
    await host.decide(
      { ...EVALUATION_SCOPE, actorId: 'reviewer' },
      {
        actionId: review.actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId: 'source-approval',
        decision: 'approve',
      },
    );
    const result = await service.applyAction(review.actionId);
    expect(result.state).toBe('succeeded');
    expect(await service.applyAction(review.actionId)).toEqual(result);
    expect(
      await host.result(EVALUATION_SCOPE, String(result.result?.contentId)),
    ).toMatchObject({
      title: 'Source composition',
      body: 'Reference source composition',
      status: 'draft',
    });
    await expect(
      host.load(
        {
          ...EVALUATION_SCOPE,
          tenantId: '55555555-5555-4555-8555-555555555555',
        },
        itemId,
      ),
    ).rejects.toThrow();
    expect(
      (await host.load(EVALUATION_SCOPE, itemId)).reviews.actions[0].review
        .state,
    ).toBe('succeeded');
  } finally {
    await host.db.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});
