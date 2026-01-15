import { describe, expect, it } from 'vitest';
import { getLineColumn, parseSource } from '../oxc-parser.js';

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

  describe('getLineColumn', () => {
    it('should return line 1, column 1 for offset 0', () => {
      const source = 'hello world';
      const result = getLineColumn(source, 0);

      expect(result).toEqual({ line: 1, column: 1 });
    });

    it('should calculate column correctly on first line', () => {
      const source = 'hello world';
      const result = getLineColumn(source, 6); // 'w' in world

      expect(result).toEqual({ line: 1, column: 7 });
    });

    it('should calculate line and column for multi-line text', () => {
      const source = 'line1\nline2\nline3';
      //              0123456789...

      // Offset 0 = 'l' in line1
      expect(getLineColumn(source, 0)).toEqual({ line: 1, column: 1 });

      // Offset 5 = '\n' after line1
      expect(getLineColumn(source, 5)).toEqual({ line: 1, column: 6 });

      // Offset 6 = 'l' in line2 (first char of line 2)
      expect(getLineColumn(source, 6)).toEqual({ line: 2, column: 1 });

      // Offset 9 = 'e' in line2
      expect(getLineColumn(source, 9)).toEqual({ line: 2, column: 4 });

      // Offset 12 = 'l' in line3 (first char of line 3)
      expect(getLineColumn(source, 12)).toEqual({ line: 3, column: 1 });
    });

    it('should handle offset at end of file', () => {
      const source = 'hello';
      const result = getLineColumn(source, 5); // At length

      expect(result).toEqual({ line: 1, column: 6 });
    });

    it('should handle multiple consecutive newlines', () => {
      const source = 'a\n\n\nb';
      //              01234

      expect(getLineColumn(source, 0)).toEqual({ line: 1, column: 1 }); // 'a'
      expect(getLineColumn(source, 1)).toEqual({ line: 1, column: 2 }); // first '\n'
      expect(getLineColumn(source, 2)).toEqual({ line: 2, column: 1 }); // second '\n'
      expect(getLineColumn(source, 3)).toEqual({ line: 3, column: 1 }); // third '\n'
      expect(getLineColumn(source, 4)).toEqual({ line: 4, column: 1 }); // 'b'
    });

    it('should handle CRLF line endings', () => {
      const source = 'line1\r\nline2\r\nline3';
      //              01234567890123456789

      // Note: CRLF is treated as two characters, only \n advances line
      expect(getLineColumn(source, 0)).toEqual({ line: 1, column: 1 }); // 'l'
      expect(getLineColumn(source, 5)).toEqual({ line: 1, column: 6 }); // '\r'
      expect(getLineColumn(source, 6)).toEqual({ line: 1, column: 7 }); // '\n'
      expect(getLineColumn(source, 7)).toEqual({ line: 2, column: 1 }); // 'l' in line2
    });

    it('should handle empty string', () => {
      const source = '';
      const result = getLineColumn(source, 0);

      expect(result).toEqual({ line: 1, column: 1 });
    });

    it('should return undefined for negative offset', () => {
      const source = 'hello';
      const result = getLineColumn(source, -1);

      expect(result).toBeUndefined();
    });

    it('should return undefined for offset beyond file length', () => {
      const source = 'hello';
      const result = getLineColumn(source, 10);

      expect(result).toBeUndefined();
    });

    it('should handle file ending with newline', () => {
      const source = 'line1\n';
      //              012345

      expect(getLineColumn(source, 5)).toEqual({ line: 1, column: 6 }); // '\n'
      expect(getLineColumn(source, 6)).toEqual({ line: 2, column: 1 }); // at length
    });

    it('should handle realistic TypeScript code', () => {
      const source = `class Foo {
  name: string;
  age: number;
}`;
      // Line 1: 'class Foo {\n' (12 chars including newline)
      // Line 2: '  name: string;\n' (16 chars)
      // Line 3: '  age: number;\n' (15 chars)
      // Line 4: '}'

      // First char
      expect(getLineColumn(source, 0)).toEqual({ line: 1, column: 1 });

      // First char of line 2 (after 'class Foo {\n')
      expect(getLineColumn(source, 12)).toEqual({ line: 2, column: 1 });

      // 'n' in 'name' on line 2
      expect(getLineColumn(source, 14)).toEqual({ line: 2, column: 3 });
    });
  });
});
