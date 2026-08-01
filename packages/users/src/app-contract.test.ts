import { describe, expect, it } from 'vitest';
import {
  canonicalizeDiscoveryArtifact,
  createDiscoveryConformanceArtifact,
  DiscoveryArtifactValidationError,
  type DiscoveryPayload,
  deriveCommandRequirements,
  validateDiscoveryConformanceArtifact,
} from './app-contract.js';

const discovery: DiscoveryPayload = {
  user: { authenticated: true, id: 'user-1' },
  warnings: ['z-warning', 'a-warning'],
  resources: [
    {
      slug: 'zebras',
      className: 'Zebra',
      label: 'Zebra',
      apiPath: 'zebras',
      commands: [
        {
          methodName: 'write',
          commandName: 'write',
          kind: 'custom',
          scope: 'collection',
          httpMethod: 'POST',
          pathSegments: ['write'],
        },
      ],
    },
    {
      slug: 'alpacas',
      className: 'Alpaca',
      label: 'Alpaca',
      apiPath: 'alpacas',
      commands: [
        {
          methodName: 'zebra',
          commandName: 'zebra',
          kind: 'custom',
          scope: 'collection',
          httpMethod: 'POST',
          pathSegments: ['zebra'],
        },
        {
          methodName: 'alpha',
          commandName: 'alpha',
          kind: 'custom',
          scope: 'collection',
          httpMethod: 'POST',
          pathSegments: ['alpha'],
        },
      ],
    },
  ],
};

describe('SMRT discovery conformance artifact', () => {
  it('is deterministic, validates its schema, and exposes the result contract', () => {
    const first = createDiscoveryConformanceArtifact(discovery);
    const second = createDiscoveryConformanceArtifact({
      ...discovery,
      warnings: [...discovery.warnings].reverse(),
      resources: [...discovery.resources].reverse(),
    });

    expect(first.integrity.digest).toBe(second.integrity.digest);
    const { integrity: _firstIntegrity, ...firstUnsigned } = first;
    const { integrity: _secondIntegrity, ...secondUnsigned } = second;
    expect(canonicalizeDiscoveryArtifact(firstUnsigned)).toBe(
      canonicalizeDiscoveryArtifact(secondUnsigned),
    );
    expect(first.discovery.warnings).toEqual(['a-warning', 'z-warning']);
    expect(first.discovery.resources.map((resource) => resource.slug)).toEqual([
      'alpacas',
      'zebras',
    ]);
    expect(
      first.discovery.resources[0]?.commands.map(
        (command) => command.commandName,
      ),
    ).toEqual(['alpha', 'zebra']);
    expect(validateDiscoveryConformanceArtifact(first)).toEqual(first);
    expect(first.resultContract).toEqual({
      schema: 'https://smrt.dev/schemas/app-result/v1',
      version: 1,
      mcpMetadataKey: 'io.happyvertical/smrt',
      metadataFields: [
        'code',
        'message',
        'details',
        'retryable',
        'correlationId',
        'idempotencyKey',
        'expectedVersion',
      ],
    });
  });

  it('rejects malformed ordering and integrity tampering', () => {
    const artifact = createDiscoveryConformanceArtifact(discovery);
    const unsorted = {
      ...artifact,
      discovery: {
        ...artifact.discovery,
        warnings: [...artifact.discovery.warnings].reverse(),
      },
    };
    expect(() => validateDiscoveryConformanceArtifact(unsorted)).toThrow(
      DiscoveryArtifactValidationError,
    );

    const tampered = {
      ...artifact,
      discovery: { ...artifact.discovery, user: { authenticated: false } },
    };
    expect(() => validateDiscoveryConformanceArtifact(tampered)).toThrow(
      /digest/,
    );
  });

  it('projects declared idempotency and expected-version fields', () => {
    expect(
      deriveCommandRequirements({
        type: 'object',
        properties: { expectedVersion: {}, idempotencyKey: {}, title: {} },
        required: ['idempotencyKey'],
      }),
    ).toEqual({
      idempotencyKey: { field: 'idempotencyKey', required: true },
      expectedVersion: { field: 'expectedVersion', required: false },
    });

    const expectedVersionOnly = deriveCommandRequirements({
      type: 'object',
      properties: { expectedVersion: {} },
    });
    expect(expectedVersionOnly).toEqual({
      expectedVersion: { field: 'expectedVersion', required: false },
    });
    expect(Object.keys(expectedVersionOnly ?? {})).toEqual(['expectedVersion']);

    const resource = discovery.resources[0];
    if (!resource) throw new Error('test discovery requires one resource');
    const command = resource.commands[0];
    if (!command) throw new Error('test resource requires one command');
    const artifact = createDiscoveryConformanceArtifact({
      ...discovery,
      resources: [
        {
          ...resource,
          commands: [{ ...command, requirements: expectedVersionOnly }],
        },
      ],
    });
    expect(validateDiscoveryConformanceArtifact(artifact)).toEqual(artifact);
  });
});
