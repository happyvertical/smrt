import { getAI } from '@happyvertical/ai';
import { getOCR, UnlimitedOCRProvider } from '@happyvertical/ocr';
import { getPDFReader } from '@happyvertical/pdf';
import { getTranscriber } from '@happyvertical/speech';
import type { ExtractionSDKConfiguration } from './extraction.js';
import {
  type ExtractionProviders,
  extractWithProviders,
} from './extraction-providers.js';
import type { ExtractionRequest } from './extraction-types.js';

// A separate entry, never imported by browser or normal server initialization.
process.once(
  'message',
  async (message: {
    request: Omit<ExtractionRequest, 'signal' | 'beforeProviderCall'>;
    configuration: ExtractionSDKConfiguration;
  }) => {
    try {
      const { request, configuration } = message;
      let sequence = 0;
      const beforeProviderCall = () =>
        new Promise<void>((resolve) => {
          const id = ++sequence;
          const receive = (reply: { kind: string; id?: number }) => {
            if (reply.kind === 'authorized' && reply.id === id) {
              process.off('message', receive);
              resolve();
            }
          };
          process.on('message', receive);
          process.send?.({ kind: 'authorize', id });
        });
      const providers: ExtractionProviders = {
        imageMode: configuration.imageMode,
      };
      const mime = request.evidence.mediaType
        .split(';')[0]
        .trim()
        .toLowerCase();
      const needsImages =
        mime === 'application/pdf' || mime.startsWith('image/');
      if (configuration.pdf && mime === 'application/pdf')
        providers.pdf = {
          identity: configuration.pdf.identity,
          client: await getPDFReader({
            provider: configuration.pdf.provider,
            enableOCR: false,
            maxFileSize: request.limits.maxBytes,
            timeout: request.limits.timeoutMs,
          }),
        };
      if (
        configuration.ocr &&
        needsImages &&
        (mime === 'application/pdf' || configuration.imageMode !== 'vision')
      ) {
        const config = configuration.ocr;
        const unlimited =
          config.identity.provider === 'unlimited-ocr'
            ? new UnlimitedOCRProvider(config.options)
            : undefined;
        const factory = getOCR({
          provider: config.identity.provider,
          fallbackProviders: [],
          providerConfig: { [config.identity.provider]: config.options ?? {} },
        });
        providers.ocr = {
          identity: config.identity,
          performOCR: (images, options) =>
            unlimited
              ? unlimited.performOCR(images, options)
              : factory.performOCR(images, options),
          capabilities: async () => {
            if (unlimited) return unlimited.checkCapabilities();
            const infos = await factory.getProvidersInfo();
            const info = infos.find(
              (candidate) => candidate.name === config.identity.provider,
            );
            if (!info?.available || !info.capabilities)
              throw new Error('Provider unavailable');
            return info.capabilities;
          },
        };
      }
      if (configuration.speech && mime.startsWith('audio/'))
        providers.speech = {
          identity: configuration.speech.identity,
          client: await getTranscriber(configuration.speech.options),
        };
      if (
        configuration.vision &&
        needsImages &&
        configuration.imageMode === 'vision'
      )
        providers.vision = {
          identity: configuration.vision.identity,
          client: await getAI(configuration.vision.options),
        };
      const result = await extractWithProviders(
        { ...request, beforeProviderCall },
        providers,
        (partial) => process.send?.({ kind: 'progress', result: partial }),
      );
      process.send?.({ kind: 'result', result }, () => process.exit(0));
    } catch {
      process.send?.({ kind: 'failure' }, () => process.exit(1));
    }
  },
);
