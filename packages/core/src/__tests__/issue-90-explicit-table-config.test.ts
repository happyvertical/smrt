import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

describe('Issue #90: Explicit table configuration', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  it('should respect table name when using "table" property', async () => {
    // This test demonstrates the issue: using 'table' instead of 'tableName'
    // The table name is DIFFERENT from what would be auto-generated
    @smrt({
      table: 'my_custom_forecasts', // User-friendly property name (NOT 'weather_forecasts')
      api: { include: ['list', 'get'] },
    })
    class WeatherForecast extends SmrtObject {
      name = '';
      temperature = 0;
    }

    class WeatherForecastCollection extends SmrtCollection<WeatherForecast> {
      static readonly _itemClass = WeatherForecast;
    }

    const collection = await WeatherForecastCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // Verify the table name is what we specified, NOT auto-generated 'weather_forecasts'
    expect(collection.tableName).toBe('my_custom_forecasts');

    // Verify it works end-to-end
    const forecast = await collection.create({
      slug: 'test-forecast',
      name: 'Sunny Day',
      temperature: 75,
    });
    await forecast.save();

    const retrieved = await collection.get('test-forecast');
    expect(retrieved?.name).toBe('Sunny Day');
    expect(retrieved?.temperature).toBe(75);
  });

  it('should continue to support "tableName" for backward compatibility', async () => {
    @smrt({
      tableName: 'legacy_products', // Existing property name
      api: { include: ['list', 'get'] },
    })
    class Product extends SmrtObject {
      name = '';
      price = 0;
    }

    class ProductCollection extends SmrtCollection<Product> {
      static readonly _itemClass = Product;
    }

    const collection = await ProductCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    expect(collection.tableName).toBe('legacy_products');
  });

  it('should prioritize "table" over "tableName" when both are provided', async () => {
    @smrt({
      table: 'priority_table', // Should take priority
      tableName: 'fallback_table', // Should be ignored
      api: { include: ['list', 'get'] },
    })
    class TestObject extends SmrtObject {
      name = '';
    }

    class TestCollection extends SmrtCollection<TestObject> {
      static readonly _itemClass = TestObject;
    }

    const collection = await TestCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // 'table' should win
    expect(collection.tableName).toBe('priority_table');
  });

  it('should auto-generate table name when neither "table" nor "tableName" provided', async () => {
    @smrt({
      api: { include: ['list', 'get'] },
    })
    class CustomCategory extends SmrtObject {
      name = '';
    }

    class CustomCategoryCollection extends SmrtCollection<CustomCategory> {
      static readonly _itemClass = CustomCategory;
    }

    const collection = await CustomCategoryCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // Should auto-generate: CustomCategory → custom_categories
    expect(collection.tableName).toBe('custom_categories');
  });
});
