import type { CustomActionMetadata } from '../generators/custom-action';

// Source-compatibility probe: semantic metadata was added after the original
// public shape and must remain optional for consumers constructing literals.
const legacyCustomActionMetadata: CustomActionMetadata = {
  scope: 'item',
  idRequired: true,
  isStatic: false,
};

void legacyCustomActionMetadata;
