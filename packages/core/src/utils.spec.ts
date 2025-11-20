import { expect, it } from 'vitest';

import { SmrtObject } from './object';
import { smrt } from './registry';
import { fieldsFromClass } from './utils';

// import { contentToString, stringToContent } from '@have/content';
// import { faker } from '@faker-js/faker';
// import { Content } from '@have/content';

// Test class with various field types
// Phase 2: Must use @smrt() decorator for fieldsFromClass() to work
@smrt()
class TestClass extends SmrtObject {
  test_string: string = '';
  test_number: number = 0;
  test_date: Date = new Date();
  methodField() {
    return true;
  }
}

it('should get fields from a class without values', async () => {
  const fields = await fieldsFromClass(TestClass);
  expect(fields).toEqual({
    // Inherited fields from SmrtObject (empty options for base fields)
    id: {
      name: 'id',
      type: 'text',
      _meta: {},
    },
    slug: {
      name: 'slug',
      type: 'text',
      _meta: {},
    },
    context: {
      name: 'context',
      type: 'text',
      _meta: {},
    },
    created_at: {
      name: 'created_at',
      type: 'datetime',
      _meta: {},
    },
    updated_at: {
      name: 'updated_at',
      type: 'datetime',
      _meta: {},
    },
    // Direct fields declared on TestClass (with default values, NOT required)
    test_string: {
      name: 'test_string',
      type: 'text',
      _meta: {
        default: '',
        required: false, // Has default value
      },
    },
    test_number: {
      name: 'test_number',
      type: 'integer',
      _meta: {
        default: 0,
        required: false, // Has default value
      },
    },
    test_date: {
      name: 'test_date',
      type: 'datetime',
      _meta: {
        required: false, // Has default value
      },
    },
  });

  // Verify private and method fields are excluded
  expect(fields).not.toHaveProperty('_privateField');
  expect(fields).not.toHaveProperty('methodField');
});

it('should get fields from a class with values', async () => {
  const values = {
    test_string: 'custom value',
    test_number: 456,
    test_date: '2024-01-01',
    extraField: 'should not appear',
  };

  const fields = await fieldsFromClass(TestClass, values);

  expect(fields).toEqual({
    // Inherited fields from SmrtObject (no values set)
    id: {
      name: 'id',
      type: 'text',
      _meta: {},
    },
    slug: {
      name: 'slug',
      type: 'text',
      _meta: {},
    },
    context: {
      name: 'context',
      type: 'text',
      _meta: {},
    },
    created_at: {
      name: 'created_at',
      type: 'datetime',
      _meta: {},
    },
    updated_at: {
      name: 'updated_at',
      type: 'datetime',
      _meta: {},
    },
    // Direct fields declared on TestClass (with values, NOT required)
    test_string: {
      name: 'test_string',
      type: 'text',
      _meta: {
        default: '',
        required: false, // Has default value
      },
      value: 'custom value',
    },
    test_number: {
      name: 'test_number',
      type: 'integer',
      _meta: {
        default: 0,
        required: false, // Has default value
      },
      value: 456,
    },
    test_date: {
      name: 'test_date',
      type: 'datetime',
      _meta: {
        required: false, // Has default value
      },
      value: '2024-01-01',
    },
  });

  // Verify extra field from values doesn't appear
  expect(fields).not.toHaveProperty('extraField');
});

it.skip('should be able to parse a content string', () => {
  // Disabled while content package is excluded from build
  // const data = {
  //   type: 'article',
  //   title: faker.lorem.sentence(),
  //   author: faker.person.fullName(),
  //   publish_date: faker.date.recent(),
  //   body: faker.lorem.paragraph(),
  // };
  // const toString = contentToString(data as Content);
  // const toObject = stringToContent(toString);
  // expect(toObject).toEqual(data);
});
