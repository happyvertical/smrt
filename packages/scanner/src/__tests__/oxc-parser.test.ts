import { describe, expect, it } from 'vitest';
import { parseSource } from '../oxc-parser.js';

describe('OXC Parser', () => {
  describe('parseSource', () => {
    it('should parse a simple SMRT class', () => {
      const source = `
        import { SmrtObject, smrt } from '@happyvertical/smrt-core';

        @smrt()
        class Product extends SmrtObject {
          name: string = '';
          price: number = 0.0;
        }
      `;

      const result = parseSource(source);

      expect(result.errors).toHaveLength(0);
      expect(result.classes).toHaveLength(1);
      expect(result.classes[0].className).toBe('Product');
      expect(result.classes[0].extendsClause).toBe('SmrtObject');
      expect(result.classes[0].hasSmartDecorator).toBe(true);
    });

    it('should extract field definitions with types', () => {
      const source = `
        @smrt()
        class Product extends SmrtObject {
          name: string = '';
          description: string = 'No description';
          price: number = 0.0;
          quantity: number = 0;
          active: boolean = true;
          tags: string[] = [];
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      const fields = result.classes[0].fields;

      expect(fields).toHaveLength(6);

      // Check string field
      const nameField = fields.find((f) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField?.typeAnnotation).toBe('string');
      expect(nameField?.initializer).toBe("''");

      // Check decimal field (has decimal point)
      const priceField = fields.find((f) => f.name === 'price');
      expect(priceField).toBeDefined();
      expect(priceField?.typeAnnotation).toBe('number');
      expect(priceField?.hasDecimalPoint).toBe(true);

      // Check integer field (no decimal point)
      const quantityField = fields.find((f) => f.name === 'quantity');
      expect(quantityField).toBeDefined();
      expect(quantityField?.typeAnnotation).toBe('number');
      expect(quantityField?.hasDecimalPoint).toBe(false);

      // Check boolean field
      const activeField = fields.find((f) => f.name === 'active');
      expect(activeField).toBeDefined();
      expect(activeField?.typeAnnotation).toBe('boolean');

      // Check array field
      const tagsField = fields.find((f) => f.name === 'tags');
      expect(tagsField).toBeDefined();
      expect(tagsField?.typeAnnotation).toBe('string[]');
    });

    it('should extract decorator config', () => {
      const source = `
        @smrt({
          api: { include: ['list', 'get'] },
          mcp: { include: ['list', 'get', 'analyze'] },
          cli: true
        })
        class Agent extends SmrtObject {
          name: string = '';
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      const config = result.classes[0].decoratorConfig;

      expect(config).toBeDefined();
      expect(config?.api).toEqual({ include: ['list', 'get'] });
      expect(config?.mcp).toEqual({ include: ['list', 'get', 'analyze'] });
      expect(config?.cli).toBe(true);
    });

    it('should extract method definitions', () => {
      const source = `
        @smrt()
        class Agent extends SmrtObject {
          name: string = '';

          async research(options: { query: string }): Promise<any> {
            return { results: [] };
          }

          analyze(data: string): boolean {
            return true;
          }
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      const methods = result.classes[0].methods;

      expect(methods).toHaveLength(2);

      // Check async method
      const researchMethod = methods.find((m) => m.name === 'research');
      expect(researchMethod).toBeDefined();
      expect(researchMethod?.async).toBe(true);
      expect(researchMethod?.returnType).toBe('Promise<any>');

      // Check sync method
      const analyzeMethod = methods.find((m) => m.name === 'analyze');
      expect(analyzeMethod).toBeDefined();
      expect(analyzeMethod?.async).toBe(false);
      expect(analyzeMethod?.returnType).toBe('boolean');
    });

    it('should extract extends clause with type arguments', () => {
      const source = `
        @smrt()
        class MeetingCollection extends SmrtCollection<Meeting> {
          static readonly _itemClass = Meeting;
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      expect(result.classes[0].className).toBe('MeetingCollection');
      expect(result.classes[0].extendsClause).toBe('SmrtCollection');
      expect(result.classes[0].extendsTypeArg).toBe('Meeting');
    });

    it('should handle classes without @smrt decorator', () => {
      const source = `
        class Helper {
          static format(value: string): string {
            return value.toUpperCase();
          }
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      expect(result.classes[0].hasSmartDecorator).toBe(false);
    });

    it('should handle exported classes', () => {
      const source = `
        export @smrt()
        class ExportedProduct extends SmrtObject {
          name: string = '';
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      expect(result.classes[0].className).toBe('ExportedProduct');
      expect(result.classes[0].hasSmartDecorator).toBe(true);
    });

    it('should handle STI table strategy', () => {
      const source = `
        @smrt({ tableStrategy: 'sti' })
        class Event extends SmrtObject {
          title: string = '';
          date: Date = new Date();
        }

        @smrt()
        class Meeting extends Event {
          roomNumber: string = '';
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(2);

      const eventClass = result.classes.find((c) => c.className === 'Event');
      expect(eventClass?.decoratorConfig?.tableStrategy).toBe('sti');

      const meetingClass = result.classes.find(
        (c) => c.className === 'Meeting',
      );
      expect(meetingClass?.extendsClause).toBe('Event');
    });

    it('should extract field helpers', () => {
      const source = `
        @smrt()
        class Order extends SmrtObject {
          customerId = foreignKey(Customer);
          total = decimal({ required: true });
          quantity = integer({ min: 0 });
        }
      `;

      const result = parseSource(source);

      expect(result.classes).toHaveLength(1);
      const fields = result.classes[0].fields;

      expect(fields).toHaveLength(3);

      // Check foreignKey field
      const customerIdField = fields.find((f) => f.name === 'customerId');
      expect(customerIdField).toBeDefined();
      expect(customerIdField?.initializer).toContain('foreignKey');

      // Check decimal field helper
      const totalField = fields.find((f) => f.name === 'total');
      expect(totalField).toBeDefined();
      expect(totalField?.initializer).toContain('decimal');

      // Check integer field helper
      const quantityField = fields.find((f) => f.name === 'quantity');
      expect(quantityField).toBeDefined();
      expect(quantityField?.initializer).toContain('integer');
    });

    it('should handle parse errors gracefully', () => {
      const source = `
        @smrt()
        class Broken extends SmrtObject {
          name: string = // missing value
        }
      `;

      const result = parseSource(source);

      // Should have parse errors
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should track parse time', () => {
      const source = `
        @smrt()
        class Product extends SmrtObject {
          name: string = '';
        }
      `;

      const result = parseSource(source);

      expect(result.parseTimeMs).toBeDefined();
      expect(result.parseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
