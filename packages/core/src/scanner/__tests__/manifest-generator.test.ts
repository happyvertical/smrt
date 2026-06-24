import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type {
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../types';

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

  describe('report objects', () => {
    it('defaults read surfaces and conflict columns from report metadata', () => {
      const generator = new ManifestGenerator();

      const manifest = generator.generateManifest([
        {
          filePath: '/path/to/daily-sales-report.ts',
          objects: [
            {
              name: 'dailySalesReport',
              className: 'DailySalesReport',
              collection: 'dailySalesReports',
              filePath: '/path/to/daily-sales-report.ts',
              fields: {
                storeId: {
                  type: 'text',
                  _meta: {
                    __report: { kind: 'group', sourceColumn: 'storeId' },
                  },
                },
                issuedDay: {
                  type: 'datetime',
                  _meta: {
                    __report: {
                      kind: 'bucket',
                      unit: 'day',
                      sourceColumn: 'issuedAt',
                    },
                  },
                },
                revenue: {
                  type: 'decimal',
                  _meta: {
                    __report: {
                      kind: 'aggregate',
                      fn: 'sum',
                      column: 'totalAmount',
                    },
                  },
                },
              },
              methods: {},
              decoratorConfig: {
                report: { source: 'Sale' },
              },
              exportName: 'DailySalesReport',
              collectionExportName: 'DailySalesReportCollection',
            },
          ],
          imports: [],
          exports: [],
        },
      ]);

      const obj = manifest.objects.dailySalesReport;

      expect(obj.decoratorConfig.api).toEqual({ include: ['list', 'get'] });
      expect(obj.decoratorConfig.mcp).toEqual({ include: ['list', 'get'] });
      expect(obj.decoratorConfig.conflictColumns).toEqual([
        'tenant_id',
        'store_id',
        'issued_day',
      ]);
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

  describe('tenant scoped schema contract', () => {
    it('injects tenantId fields before generating schemas', () => {
      const generator = new ManifestGenerator();

      const manifest = generator.generateManifest([
        {
          filePath: '/path/to/secret.ts',
          objects: [
            {
              name: 'secret',
              className: 'Secret',
              collection: 'secrets',
              filePath: '/path/to/secret.ts',
              fields: {},
              methods: {},
              decoratorConfig: { tenantScoped: true },
              exportName: 'Secret',
              collectionExportName: 'SecretCollection',
            },
          ],
          imports: [],
          exports: [],
        },
      ]);

      const secret = manifest.objects.secret;
      expect(secret.fields.tenantId).toEqual(
        expect.objectContaining({
          type: 'text',
          _meta: expect.objectContaining({
            sqlType: 'UUID',
            __tenancy: expect.objectContaining({
              isTenantIdField: true,
              mode: 'required',
              field: 'tenantId',
            }),
          }),
        }),
      );
      expect(secret.schema?.columns.tenant_id).toEqual(
        expect.objectContaining({ type: 'UUID', referenceKind: 'tenantId' }),
      );
    });

    it('preserves explicit tenantId fields while adding tenancy metadata', () => {
      const generator = new ManifestGenerator();

      const manifest = generator.generateManifest([
        {
          filePath: '/path/to/scoped-membership.ts',
          objects: [
            {
              name: 'scopedMembership',
              className: 'ScopedMembership',
              collection: 'scoped_memberships',
              filePath: '/path/to/scoped-membership.ts',
              fields: {
                tenantId: {
                  type: 'foreignKey',
                  related: 'Tenant',
                  _meta: {
                    sqlType: 'text',
                    indexed: true,
                  },
                },
              },
              methods: {},
              decoratorConfig: { tenantScoped: true },
              exportName: 'ScopedMembership',
              collectionExportName: 'ScopedMembershipCollection',
            },
          ],
          imports: [],
          exports: [],
        },
      ]);

      const membership = manifest.objects.scopedMembership;
      expect(membership.fields.tenantId).toEqual(
        expect.objectContaining({
          type: 'foreignKey',
          related: 'Tenant',
          _meta: expect.objectContaining({
            sqlType: 'UUID',
            indexed: true,
            __tenancy: expect.objectContaining({
              isTenantIdField: true,
              mode: 'required',
              field: 'tenantId',
            }),
          }),
        }),
      );
      expect(membership.schema?.columns.tenant_id).toEqual(
        expect.objectContaining({ type: 'UUID', referenceKind: 'tenantId' }),
      );
    });

    it('rejects tenant scoped objects with non-text tenant fields', () => {
      const generator = new ManifestGenerator();

      expect(() =>
        generator.generateManifest([
          {
            filePath: '/path/to/secret.ts',
            objects: [
              {
                name: 'secret',
                className: 'Secret',
                collection: 'secrets',
                filePath: '/path/to/secret.ts',
                fields: {
                  tenantId: {
                    type: 'integer',
                  },
                },
                methods: {},
                decoratorConfig: { tenantScoped: true },
                exportName: 'Secret',
                collectionExportName: 'SecretCollection',
              },
            ],
            imports: [],
            exports: [],
          },
        ]),
      ).toThrow(
        /Secret: tenant-scoped field "tenantId" must use type "text" or "foreignKey"; received "integer"/,
      );
    });

    it('rejects tenant scoped objects with non-UUID-compatible tenant SQL columns', () => {
      const generator = new ManifestGenerator();

      expect(() =>
        generator.generateManifest([
          {
            filePath: '/path/to/secret.ts',
            objects: [
              {
                name: 'secret',
                className: 'Secret',
                collection: 'secrets',
                filePath: '/path/to/secret.ts',
                fields: {
                  tenantId: {
                    type: 'text',
                    _meta: {
                      sqlType: 'INTEGER',
                    },
                  },
                },
                methods: {},
                decoratorConfig: { tenantScoped: true },
                exportName: 'Secret',
                collectionExportName: 'SecretCollection',
              },
            ],
            imports: [],
            exports: [],
          },
        ]),
      ).toThrow(
        /Secret: tenant-scoped field "tenantId" must use SQL type "UUID" or legacy "TEXT"; received "INTEGER"/,
      );
    });

    it('fails when a tenant scoped object is missing its tenant field', () => {
      const generator = new ManifestGenerator();
      const manifest: SmartObjectManifest = {
        version: '1.0.0',
        timestamp: 0,
        objects: {
          secret: {
            name: 'secret',
            className: 'Secret',
            collection: 'secrets',
            filePath: '/path/to/secret.ts',
            fields: {},
            methods: {},
            decoratorConfig: { tenantScoped: true },
            exportName: 'Secret',
            collectionExportName: 'SecretCollection',
          },
        },
      };

      expect(() =>
        generator.assertTenantScopedSchemaContract(manifest),
      ).toThrow(/Secret: missing tenant-scoped field "tenantId"/);
    });

    it('fails when a tenant scoped schema has not been generated', () => {
      const generator = new ManifestGenerator();
      const manifest: SmartObjectManifest = {
        version: '1.0.0',
        timestamp: 0,
        objects: {
          secret: {
            name: 'secret',
            className: 'Secret',
            collection: 'secrets',
            filePath: '/path/to/secret.ts',
            fields: {
              tenantId: {
                type: 'text',
                _meta: {
                  sqlType: 'UUID',
                  __tenancy: {
                    isTenantIdField: true,
                    mode: 'required',
                    field: 'tenantId',
                  },
                },
              },
            },
            methods: {},
            decoratorConfig: { tenantScoped: true },
            exportName: 'Secret',
            collectionExportName: 'SecretCollection',
          },
        },
      };

      expect(() =>
        generator.assertTenantScopedSchemaContract(manifest),
      ).toThrow(
        /Secret: schema has not been generated for tenant-scoped column "tenant_id"/,
      );
    });

    it('fails when a tenant scoped schema is missing its SQL column', () => {
      const generator = new ManifestGenerator();
      const manifest: SmartObjectManifest = {
        version: '1.0.0',
        timestamp: 0,
        objects: {
          secret: {
            name: 'secret',
            className: 'Secret',
            collection: 'secrets',
            filePath: '/path/to/secret.ts',
            fields: {
              tenantId: {
                type: 'text',
                _meta: {
                  sqlType: 'UUID',
                  __tenancy: {
                    isTenantIdField: true,
                    mode: 'required',
                    field: 'tenantId',
                  },
                },
              },
            },
            methods: {},
            decoratorConfig: { tenantScoped: true },
            exportName: 'Secret',
            collectionExportName: 'SecretCollection',
            schema: {
              tableName: 'secrets',
              ddl: 'CREATE TABLE "secrets" ("id" TEXT PRIMARY KEY)',
              columns: {
                id: { type: 'TEXT', primaryKey: true },
              },
              indexes: [],
              version: 'test',
            },
          },
        },
      };

      expect(() =>
        generator.assertTenantScopedSchemaContract(manifest),
      ).toThrow(/Secret: schema is missing tenant-scoped column "tenant_id"/);
    });
  });
});
