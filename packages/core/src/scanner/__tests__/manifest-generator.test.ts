import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type { ScanResult, SmartObjectDefinition } from '../types';

describe('ManifestGenerator', () => {
  describe('class name collision detection', () => {
    it('should throw an error when duplicate class names are found', () => {
      const generator = new ManifestGenerator();

      const objectDef1: SmartObjectDefinition = {
        name: 'product',
        className: 'Product',
        collection: 'products',
        filePath: '/path/to/file1.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Product',
        collectionExportName: 'ProductCollection',
      };

      const objectDef2: SmartObjectDefinition = {
        name: 'product',
        className: 'Product',
        collection: 'products',
        filePath: '/path/to/file2.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Product',
        collectionExportName: 'ProductCollection',
      };

      const scanResults: ScanResult[] = [
        {
          filePath: '/path/to/file1.ts',
          objects: [objectDef1],
          imports: [],
          exports: [],
        },
        {
          filePath: '/path/to/file2.ts',
          objects: [objectDef2],
          imports: [],
          exports: [],
        },
      ];

      // Issue #713: Error message now includes qualified name hint
      expect(() => generator.generateManifest(scanResults)).toThrow(
        /Class name collision detected: 'Product'.*is defined in multiple files/,
      );
    });

    it('should not throw when all class names are unique', () => {
      const generator = new ManifestGenerator();

      const objectDef1: SmartObjectDefinition = {
        name: 'product',
        className: 'Product',
        collection: 'products',
        filePath: '/path/to/file1.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Product',
        collectionExportName: 'ProductCollection',
      };

      const objectDef2: SmartObjectDefinition = {
        name: 'category',
        className: 'Category',
        collection: 'categories',
        filePath: '/path/to/file2.ts',
        fields: {},
        methods: {},
        decoratorConfig: {},
        exportName: 'Category',
        collectionExportName: 'CategoryCollection',
      };

      const scanResults: ScanResult[] = [
        {
          filePath: '/path/to/file1.ts',
          objects: [objectDef1],
          imports: [],
          exports: [],
        },
        {
          filePath: '/path/to/file2.ts',
          objects: [objectDef2],
          imports: [],
          exports: [],
        },
      ];

      expect(() => generator.generateManifest(scanResults)).not.toThrow();
    });
  });

  describe('generateAgentManifests', () => {
    it('should include signalSubscriptions in agent manifest when declared', () => {
      const generator = new ManifestGenerator();

      const manifest = generator.generateManifest([
        {
          filePath: '/path/to/my-handler.ts',
          objects: [
            {
              name: 'myHandler',
              className: 'MyHandler',
              collection: 'agents',
              filePath: '/path/to/my-handler.ts',
              fields: {},
              methods: {},
              decoratorConfig: {
                agent: {
                  icon: 'mail',
                  tier: 'standard',
                  description: 'Handles emails',
                },
              },
              staticProperties: {
                signalSubscriptions: ['email.received', 'email.bounced'],
              },
              exportName: 'MyHandler',
              collectionExportName: 'MyHandlerCollection',
            },
          ],
          imports: [],
          exports: [],
        },
      ]);

      const obj = manifest.objects.myHandler;
      expect(obj).toBeDefined();
      expect(obj.agent).toBeDefined();
      expect(obj.agent?.signalSubscriptions).toEqual([
        'email.received',
        'email.bounced',
      ]);
    });

    it('should omit signalSubscriptions from manifest when empty', () => {
      const generator = new ManifestGenerator();

      const manifest = generator.generateManifest([
        {
          filePath: '/path/to/plain-agent.ts',
          objects: [
            {
              name: 'plainAgent',
              className: 'PlainAgent',
              collection: 'agents',
              filePath: '/path/to/plain-agent.ts',
              fields: {},
              methods: {},
              decoratorConfig: {
                agent: {
                  icon: 'bot',
                  tier: 'free',
                },
              },
              exportName: 'PlainAgent',
              collectionExportName: 'PlainAgentCollection',
            },
          ],
          imports: [],
          exports: [],
        },
      ]);

      const obj = manifest.objects.plainAgent;
      expect(obj).toBeDefined();
      expect(obj.agent).toBeDefined();
      expect(obj.agent?.signalSubscriptions).toBeUndefined();
    });
  });

  describe('generateRestEndpoints', () => {
    it('should include collection class methods without duplicating CRUD endpoints', () => {
      const generator = new ManifestGenerator();

      const manifest = {
        objects: {
          Invitation: {
            name: 'invitation',
            className: 'Invitation',
            collection: 'invitations',
            fields: {},
            methods: {
              canBeRedeemed: {
                name: 'canBeRedeemed',
                isPublic: true,
                parameters: [],
              },
            },
            decoratorConfig: { api: true },
            exportName: 'Invitation',
            collectionExportName: 'InvitationCollection',
          },
          InvitationCollection: {
            name: 'invitationCollection',
            className: 'InvitationCollection',
            collection: 'invitations',
            fields: {},
            methods: {
              findByToken: {
                name: 'findByToken',
                isPublic: true,
                parameters: [{ name: 'token', type: 'string' }],
              },
            },
            decoratorConfig: { api: true },
            extends: 'SmrtCollection',
            extendsTypeArg: 'Invitation',
            exportName: 'InvitationCollection',
            collectionExportName: 'InvitationCollectionCollection',
          },
        },
      };

      const endpoints = generator.generateRestEndpoints(
        manifest as Parameters<typeof generator.generateRestEndpoints>[0],
      );

      expect(endpoints.split('\n')).toEqual([
        'GET /invitations',
        'POST /invitations',
        'GET /invitations/:id',
        'PUT /invitations/:id',
        'DELETE /invitations/:id',
        'POST /invitations/:id/canBeRedeemed',
        'POST /invitations/findByToken',
      ]);
    });

    it('should honor route metadata for collection class methods', () => {
      const generator = new ManifestGenerator();

      const manifest = {
        objects: {
          DocumentCollection: {
            name: 'documentCollection',
            className: 'DocumentCollection',
            collection: 'documents',
            fields: {},
            methods: {
              browseFacts: {
                name: 'browseFacts',
                isPublic: true,
                parameters: [{ name: 'options', type: 'any' }],
              },
            },
            decoratorConfig: {
              api: {
                include: ['browseFacts'],
                routes: {
                  browseFacts: {
                    scope: 'collection',
                    method: 'GET',
                    path: 'facts',
                  },
                },
              },
            },
            extends: 'SmrtCollection',
            extendsTypeArg: 'Document',
            exportName: 'DocumentCollection',
            collectionExportName: 'DocumentCollectionCollection',
          },
        },
      };

      const endpoints = generator.generateRestEndpoints(
        manifest as Parameters<typeof generator.generateRestEndpoints>[0],
      );

      expect(endpoints).toBe('GET /documents/facts');
    });
  });
});
