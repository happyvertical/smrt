import { describe, expect, it } from 'vitest';
import sourceManifest from '../manifest/manifest.json';

interface ManifestObject {
  fields?: Record<string, unknown>;
}

describe('persona messaging source manifest', () => {
  it('registers message routing fields and route models in source mode', () => {
    const objects = sourceManifest.objects as Record<string, ManifestObject>;
    const message = objects['@happyvertical/smrt-messages:Message'];

    expect(message?.fields).toHaveProperty('personaId');
    expect(message?.fields).toHaveProperty('endpointId');
    expect(message?.fields).toHaveProperty('correlationId');
    expect(objects).toHaveProperty(
      '@happyvertical/smrt-messages:MessagingEndpoint',
    );
    expect(objects).toHaveProperty(
      '@happyvertical/smrt-messages:PersonaMessageRoute',
    );
  });
});
