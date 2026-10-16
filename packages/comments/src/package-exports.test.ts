import { describe, expect, it } from 'vitest';
import * as participationCollections from './collections/ParticipationCollection.js';
import * as root from './index.js';

describe('package root exports', () => {
  // `smrt generate-register` imports every scanned collection class from the
  // package root, so a collection missing here breaks consumer registration.
  it('exports every participation collection', () => {
    for (const name of Object.keys(participationCollections)) {
      expect(root, name).toHaveProperty(name);
    }
  });
});
