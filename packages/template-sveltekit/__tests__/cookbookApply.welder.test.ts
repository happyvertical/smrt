import { describe, it } from 'vitest';
import { proveCookbookApply } from './support/cookbookApplyProof.js';

describe('complete bundled cookbook hosts', () => {
  it.each(['welder'])(
    'applies and boots a second %s host with signed-in sections and settings',
    proveCookbookApply,
    600_000,
  );
});
