import { expect, it } from 'vitest';
import { datetime, integer, text } from './fields';
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
  test_string = text();
  test_number = integer();
  test_date = datetime();
  methodField() {
    return true;
  }
}

it('should get fields from a class without values', async () => {
  const fields = await fieldsFromClass(TestClass);
  expect(fields).toEqual({
    // Inherited fields from SmrtObject
    id: {
      name: 'id',
      type: 'text',
    },
    slug: {
      name: 'slug',
      type: 'text',
    },
    context: {
      name: 'context',
      type: 'text',
    },
    created_at: {
      name: 'created_at',
      type: 'datetime',
    },
    updated_at: {
      name: 'updated_at',
      type: 'datetime',
    },
    // Direct fields declared on TestClass
    test_string: {
      name: 'test_string',
      type: 'text',
    },
    test_number: {
      name: 'test_number',
      type: 'integer',
    },
    test_date: {
      name: 'test_date',
      type: 'datetime',
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
    },
    slug: {
      name: 'slug',
      type: 'text',
    },
    context: {
      name: 'context',
      type: 'text',
    },
    created_at: {
      name: 'created_at',
      type: 'datetime',
    },
    updated_at: {
      name: 'updated_at',
      type: 'datetime',
    },
    // Direct fields declared on TestClass (with values)
    test_string: {
      name: 'test_string',
      type: 'text',
      value: 'custom value',
    },
    test_number: {
      name: 'test_number',
      type: 'integer',
      value: 456,
    },
    test_date: {
      name: 'test_date',
      type: 'datetime',
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
