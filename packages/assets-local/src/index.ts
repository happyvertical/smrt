import type {
  Asset,
  AssetCapabilityProvider,
  AssetEnsureVariantInput,
  AssetProcessInput,
  AssetProcessResult,
  AssetVariantFit,
  AssetVariantRequest,
  AssetVariantResult,
} from '@happyvertical/smrt-assets';
import {
  ASSET_ROLES,
  AssetCapabilitySkippedError,
} from '@happyvertical/smrt-assets';
import sharp from 'sharp';
import {
  extractAssetImageMetadataFromBuffer,
  type NormalizedAssetImageMetadata,
} from './metadata';

export {
  extractAssetImageMetadataFromBuffer,
  type NormalizedAssetImageMetadata,
  normalizeAssetImageMetadata,
} from './metadata';

export interface LocalAssetImageVariantPreset {
  width: number;
  height: number;
  fit: AssetVariantFit;
}

export interface LocalAssetProcessorOptions {
  variants?: Record<string, LocalAssetImageVariantPreset>;
  quality?: number;
}

const DEFAULT_VARIANTS: Record<string, LocalAssetImageVariantPreset> = {
  thumb: { width: 160, height: 160, fit: 'cover' },
  card: { width: 480, height: 270, fit: 'cover' },
  preview: { width: 960, height: 960, fit: 'inside' },
  publish: { width: 1200, height: 630, fit: 'cover' },
};

type AssetWithMetadata = Asset & {
  metadata?: string;
  getMetadata?: () => Record<string, unknown>;
  setMetadata?: (metadata: Record<string, unknown>) => void;
};

function parseAssetRecord(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeImageMetadata(
  asset: Asset,
  metadata: NormalizedAssetImageMetadata,
): Promise<void> {
  const structuredAsset = asset as AssetWithMetadata;
  const sidecar =
    structuredAsset.getMetadata?.() ??
    parseAssetRecord(structuredAsset.metadata);
  const nextMetadata = {
    ...sidecar,
    imageMetadata: metadata,
    imageMetadataUpdatedAt: new Date().toISOString(),
  };
  if (structuredAsset.setMetadata) {
    structuredAsset.setMetadata(nextMetadata);
  } else {
    structuredAsset.metadata = JSON.stringify(nextMetadata);
  }
  if (!asset.mimeType && metadata.mimeType) {
    asset.mimeType = metadata.mimeType;
  }
  await asset.save();
}

function resolveVariantRequest(
  request: AssetVariantRequest,
  presets: Record<string, LocalAssetImageVariantPreset>,
): Required<Pick<AssetVariantRequest, 'variant' | 'width' | 'height' | 'fit'>> {
  const preset = presets[request.variant];
  const width = request.width ?? preset?.width;
  const height = request.height ?? preset?.height;
  const fit = request.fit ?? preset?.fit ?? 'cover';
  if (!width || !height) {
    throw new Error(
      `Unknown asset image variant "${request.variant}" requires width and height.`,
    );
  }
  return {
    variant: request.variant,
    width,
    height,
    fit,
  };
}

function variantExternalId(
  source: Asset,
  variant: {
    variant: string;
    width: number;
    height: number;
    fit: string;
  },
  quality: number,
): string {
  const sourceVersion = Number(source.version ?? 1) || 1;
  return [
    'smrt-assets',
    'variant',
    source.id,
    sourceVersion,
    `${variant.variant}-${variant.width}x${variant.height}-${variant.fit}-webp-q${quality}`,
  ].join(':');
}

async function findCachedVariant(
  input: AssetEnsureVariantInput,
  externalId: string,
): Promise<Asset | null> {
  if (!input.asset.id) return null;
  const derivatives = await input.runtime.collection.getDerivatives(
    input.asset.id,
  );
  return derivatives.find((child) => child.externalId === externalId) ?? null;
}

export function createLocalAssetProcessor(
  options: LocalAssetProcessorOptions = {},
): AssetCapabilityProvider {
  const variants = { ...DEFAULT_VARIANTS, ...(options.variants ?? {}) };
  const quality = options.quality ?? 82;

  async function ensureVariant(
    input: AssetEnsureVariantInput,
  ): Promise<AssetVariantResult> {
    if (!input.asset.mimeType?.startsWith('image/')) {
      throw new AssetCapabilitySkippedError(
        'ensureVariant',
        'Local processor only handles image assets.',
      );
    }
    if (!input.asset.id) {
      throw new Error('Local asset variants require a persisted source asset.');
    }

    const variant = resolveVariantRequest(input.request, variants);
    const externalId = variantExternalId(input.asset, variant, quality);
    const cached = await findCachedVariant(input, externalId);
    if (cached) {
      return {
        asset: cached,
        variant: variant.variant,
        source: 'cached',
        url: cached.sourceUri,
        metadata:
          (cached as AssetWithMetadata).getMetadata?.() ??
          parseAssetRecord((cached as AssetWithMetadata).metadata),
      };
    }

    const source = await input.runtime.store.read(input.asset);
    const { data, info } = await sharp(source)
      .rotate()
      .resize({
        width: variant.width,
        height: variant.height,
        fit: variant.fit,
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    const variantMetadata = {
      assetVariant: {
        sourceAssetId: input.asset.id,
        sourceVersion: Number(input.asset.version ?? 1) || 1,
        ...variant,
        format: 'webp',
        quality,
      },
    };
    const derived = await input.runtime.storeDerivedAsset(
      input.asset,
      `${input.asset.name || input.asset.id} ${variant.variant}.webp`,
      data,
      {
        mimeType: 'image/webp',
        typeSlug: 'image-variant',
        role: ASSET_ROLES.ASSET_VARIANT,
        description: `Generated ${variant.variant} image variant for ${input.asset.name || input.asset.id}`,
        externalId,
        sourceType: 'smrt-assets-local',
        metadata: variantMetadata,
      },
    );

    return {
      asset: derived,
      variant: variant.variant,
      source: 'generated',
      url: derived.sourceUri,
      metadata: {
        width: info.width,
        height: info.height,
        mimeType: 'image/webp',
      },
    };
  }

  return {
    name: 'smrt-assets-local',
    async processAsset(input: AssetProcessInput): Promise<AssetProcessResult> {
      if (!input.asset.mimeType?.startsWith('image/')) {
        throw new AssetCapabilitySkippedError(
          'processAsset',
          'Local processor only handles image assets.',
        );
      }

      const data = await input.runtime.store.read(input.asset);
      const metadata = await extractAssetImageMetadataFromBuffer(data);
      await writeImageMetadata(input.asset, metadata);
      const requested =
        input.variants ?? Object.keys(variants).map((variant) => ({ variant }));
      const generatedVariants = await Promise.all(
        requested.map((request) =>
          ensureVariant({
            runtime: input.runtime,
            asset: input.asset,
            request,
          }),
        ),
      );
      return {
        asset: input.asset,
        metadata,
        variants: generatedVariants,
      };
    },
    ensureVariant,
  };
}
