import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import type { RawClassDefinition } from '../types.js';

describe('InheritanceResolver', () => {
  const createClass = (
    className: string,
    extendsClause: string | null = null,
    fields: RawClassDefinition['fields'] = [],
    decoratorConfig: RawClassDefinition['decoratorConfig'] = null,
  ): RawClassDefinition => ({
    className,
    filePath: `src/${className}.ts`,
    extendsClause,
    extendsTypeArg: null,
    decoratorConfig,
    hasSmartDecorator: true,
    fields,
    methods: [],
    startLine: 1,
    endLine: 10,
  });

  describe('resolveInheritanceChain', () => {
    it('should resolve simple inheritance chain', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass('SmrtObject', null),
        createClass('Product', 'SmrtObject'),
      ]);

      const chain = resolver.resolveInheritanceChain('Product');

      expect(chain).toEqual(['SmrtObject', 'Product']);
    });

    it('should resolve multi-level inheritance', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass('SmrtObject', null),
        createClass('Content', 'SmrtObject'),
        createClass('Article', 'Content'),
        createClass('NewsArticle', 'Article'),
      ]);

      const chain = resolver.resolveInheritanceChain('NewsArticle');

      expect(chain).toEqual([
        'SmrtObject',
        'Content',
        'Article',
        'NewsArticle',
      ]);
    });

    it('should handle missing parent class', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass('Product', 'SmrtObject'), // SmrtObject recognized as framework base
      ]);

      const chain = resolver.resolveInheritanceChain('Product');

      // Should include SmrtObject (framework base) and Product
      expect(chain).toContain('SmrtObject');
      expect(chain).toContain('Product');
    });
  });

  describe('resolveAll', () => {
    it('should merge inherited fields for STI', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass(
          'Event',
          'SmrtObject',
          [
            {
              name: 'title',
              typeAnnotation: 'string',
              initializer: "''",
              hasDecimalPoint: false,
              numericValue: null,
              decorators: [],
              optional: false,
              readonly: false,
              accessibility: 'public',
              line: 1,
            },
          ],
          { tableStrategy: 'sti' },
        ),
        createClass('Meeting', 'Event', [
          {
            name: 'roomNumber',
            typeAnnotation: 'string',
            initializer: "''",
            hasDecimalPoint: false,
            numericValue: null,
            decorators: [],
            optional: false,
            readonly: false,
            accessibility: 'public',
            line: 2,
          },
        ]),
      ]);

      const resolved = resolver.resolveAll();

      const meeting = resolved.find((c) => c.className === 'Meeting');
      expect(meeting).toBeDefined();

      // allFields should have both inherited and own fields for STI
      const fieldNames = meeting?.allFields.map((f) => f.name);
      expect(fieldNames).toContain('title'); // inherited
      expect(fieldNames).toContain('roomNumber'); // own
    });

    it('should detect STI strategy from decorator config', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass(
          'Event',
          'SmrtObject',
          [
            {
              name: 'title',
              typeAnnotation: 'string',
              initializer: "''",
              hasDecimalPoint: false,
              numericValue: null,
              decorators: [],
              optional: false,
              readonly: false,
              accessibility: 'public',
              line: 1,
            },
          ],
          { tableStrategy: 'sti' },
        ),
        createClass('Meeting', 'Event', [
          {
            name: 'roomNumber',
            typeAnnotation: 'string',
            initializer: "''",
            hasDecimalPoint: false,
            numericValue: null,
            decorators: [],
            optional: false,
            readonly: false,
            accessibility: 'public',
            line: 2,
          },
        ]),
      ]);

      const resolved = resolver.resolveAll();

      const event = resolved.find((c) => c.className === 'Event');
      expect(event?.effectiveTableStrategy).toBe('sti');
      expect(event?.stiBase).toBe('Event');

      const meeting = resolved.find((c) => c.className === 'Meeting');
      expect(meeting?.effectiveTableStrategy).toBe('sti');
      expect(meeting?.stiBase).toBe('Event');
    });

    it('should calculate inheritance depth', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass('Content', 'SmrtObject'),
        createClass('Article', 'Content'),
      ]);

      const resolved = resolver.resolveAll();

      const content = resolved.find((c) => c.className === 'Content');
      expect(content?.inheritanceChain.length).toBe(2); // SmrtObject, Content

      const article = resolved.find((c) => c.className === 'Article');
      expect(article?.inheritanceChain.length).toBe(3); // SmrtObject, Content, Article
    });

    it('should preserve method definitions', () => {
      const resolver = new InheritanceResolver();
      const agentClass: RawClassDefinition = {
        ...createClass('Agent', 'SmrtObject'),
        methods: [
          {
            name: 'research',
            async: true,
            isStatic: false,
            accessibility: 'public',
            parameters: [
              {
                name: 'query',
                type: 'string',
                optional: false,
                defaultValue: null,
              },
            ],
            returnType: 'Promise<any>',
            description: null,
            line: 5,
          },
        ],
      };
      resolver.addClasses([agentClass]);

      const resolved = resolver.resolveAll();

      const agent = resolved.find((c) => c.className === 'Agent');
      expect(agent?.methods).toHaveLength(1);
      expect(agent?.methods[0].name).toBe('research');
      expect(agent?.methods[0].async).toBe(true);
    });
  });

  describe('isSTIClass', () => {
    it('should detect STI classes', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass('Event', 'SmrtObject', [], { tableStrategy: 'sti' }),
        createClass('Meeting', 'Event'),
        createClass('Product', 'SmrtObject'),
      ]);

      expect(resolver.isSTIClass('Event')).toBe(true);
      expect(resolver.isSTIClass('Meeting')).toBe(true);
      expect(resolver.isSTIClass('Product')).toBe(false);
    });
  });

  describe('getDescendants', () => {
    it('should find all descendants', () => {
      const resolver = new InheritanceResolver();
      resolver.addClasses([
        createClass('Event', 'SmrtObject'),
        createClass('Meeting', 'Event'),
        createClass('Conference', 'Event'),
        createClass('Product', 'SmrtObject'),
      ]);

      const descendants = resolver.getDescendants('Event');

      expect(descendants).toContain('Meeting');
      expect(descendants).toContain('Conference');
      expect(descendants).not.toContain('Product');
    });
  });
});
