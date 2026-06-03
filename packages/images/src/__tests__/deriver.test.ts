import type {
  AssetAssociationCollection,
  AssetStore,
} from '@happyvertical/smrt-assets';
import { describe, expect, it, vi } from 'vitest';
import { ImageDeriver } from '../deriver';
import type { Image } from '../image';
import type { ImageCollection } from '../images';

describe('ImageDeriver', () => {
  it('records derivation provenance via generic asset associations', async () => {
    const deriver = new ImageDeriver({} as AssetStore, {} as ImageCollection, {
      ai: { type: 'openai', apiKey: 'test-key' },
    });

    const sources = [
      { id: 'source-1', name: 'Source One' },
      { id: 'source-2', name: 'Source Two' },
    ] as Image[];
    const derived = [{ id: 'derived-1', name: 'Derived One' }] as Image[];

    vi.spyOn(deriver, 'derive').mockResolvedValue(derived);

    const attach = vi.fn().mockResolvedValue(undefined);
    const associations = {
      attach,
    } as unknown as AssetAssociationCollection;

    await deriver.deriveWithAssociations(
      sources,
      'Blend the references',
      associations,
    );

    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenNthCalledWith(
      1,
      'Image',
      'derived-1',
      'source-1',
      {
        role: 'derivation-source',
      },
    );
    expect(attach).toHaveBeenNthCalledWith(
      2,
      'Image',
      'derived-1',
      'source-2',
      {
        role: 'derivation-source',
      },
    );
  });
});
