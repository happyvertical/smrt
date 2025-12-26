/**
 * Zone model tests
 *
 * Tests for:
 * 1. Zone CRUD operations
 * 2. Hierarchical relationships
 * 3. Tree operations
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PropertyCollection } from '../collections/Properties';
import { ZoneCollection } from '../collections/Zones';
import type { Property } from '../models/Property';

describe('Zone', () => {
  let dbPath: string;
  let properties: PropertyCollection;
  let zones: ZoneCollection;
  let testProperty: Property;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-zone-test-${Date.now()}.db`);
    properties = await PropertyCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    zones = await ZoneCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create a test property
    testProperty = await properties.create({
      name: 'Test Site',
      domain: 'test.com',
    });
    await testProperty.save();
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic CRUD Operations', () => {
    it('should create a zone', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Home Page',
        type: 'page',
        path: '/',
      });

      expect(zone.id).toBeDefined();
      expect(zone.name).toBe('Home Page');
      expect(zone.type).toBe('page');
      expect(zone.propertyId).toBe(testProperty.id);
    });

    it('should preserve data through save/load cycle', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Header Slot',
        type: 'slot',
        width: 728,
        height: 90,
        selector: '#header-ad',
      });
      await zone.save();

      const loaded = await zones.get({ id: zone.id });
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Header Slot');
      expect(loaded?.width).toBe(728);
      expect(loaded?.height).toBe(90);
      expect(loaded?.selector).toBe('#header-ad');
    });

    it('should update zone fields', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Original',
        width: 300,
        height: 250,
      });
      await zone.save();

      zone.name = 'Updated';
      zone.width = 336;
      zone.height = 280;
      await zone.save();

      const loaded = await zones.get({ id: zone.id });
      expect(loaded?.name).toBe('Updated');
      expect(loaded?.width).toBe(336);
      expect(loaded?.height).toBe(280);
    });

    it('should delete a zone', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Deletable',
      });
      await zone.save();

      await zone.delete();

      const loaded = await zones.get({ id: zone.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Hierarchy Operations', () => {
    it('should create hierarchical zones', async () => {
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Home Page',
        type: 'page',
        path: '/',
      });
      await page.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page.id,
        name: 'Header Slot',
        type: 'slot',
      });
      await slot.save();

      expect(slot.parentId).toBe(page.id);
      expect(page.isTopLevel()).toBe(true);
      expect(slot.isTopLevel()).toBe(false);
    });

    it('should find top-level zones', async () => {
      const page1 = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page 1',
        type: 'page',
      });
      await page1.save();

      const page2 = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page 2',
        type: 'page',
      });
      await page2.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page1.id,
        name: 'Slot',
        type: 'slot',
      });
      await slot.save();

      const topLevel = await zones.findTopLevel(testProperty.id as string);
      expect(topLevel).toHaveLength(2);
      expect(topLevel.map((z) => z.name).sort()).toEqual(['Page 1', 'Page 2']);
    });

    it('should find children of a zone', async () => {
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page',
        type: 'page',
      });
      await page.save();

      await (
        await zones.create({
          propertyId: testProperty.id as string,
          parentId: page.id,
          name: 'Slot 1',
        })
      ).save();

      await (
        await zones.create({
          propertyId: testProperty.id as string,
          parentId: page.id,
          name: 'Slot 2',
        })
      ).save();

      const children = await zones.findChildren(page.id as string);
      expect(children).toHaveLength(2);
      expect(children.map((z) => z.name).sort()).toEqual(['Slot 1', 'Slot 2']);
    });

    it('should get ancestors of a zone', async () => {
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page',
      });
      await page.save();

      const section = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page.id,
        name: 'Section',
      });
      await section.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: section.id,
        name: 'Slot',
      });
      await slot.save();

      const ancestors = await zones.getAncestors(slot.id as string);
      expect(ancestors).toHaveLength(2);
      expect(ancestors[0].name).toBe('Page'); // Root first
      expect(ancestors[1].name).toBe('Section');
    });

    it('should get descendants of a zone', async () => {
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page',
      });
      await page.save();

      const section = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page.id,
        name: 'Section',
      });
      await section.save();

      await (
        await zones.create({
          propertyId: testProperty.id as string,
          parentId: section.id,
          name: 'Slot 1',
        })
      ).save();

      await (
        await zones.create({
          propertyId: testProperty.id as string,
          parentId: section.id,
          name: 'Slot 2',
        })
      ).save();

      const descendants = await zones.getDescendants(page.id as string);
      expect(descendants).toHaveLength(3); // section + 2 slots
    });
  });

  describe('Tree Operations', () => {
    it('should build zone tree for a property', async () => {
      // Create: Page -> Section -> Slot
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Home',
        type: 'page',
      });
      await page.save();

      const section = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page.id,
        name: 'Header',
        type: 'section',
      });
      await section.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: section.id,
        name: 'Banner',
        type: 'slot',
      });
      await slot.save();

      const tree = await zones.getTree(testProperty.id as string);

      expect(tree.propertyId).toBe(testProperty.id);
      expect(tree.roots).toHaveLength(1);
      expect(tree.roots[0].zone.name).toBe('Home');
      expect(tree.roots[0].children).toHaveLength(1);
      expect(tree.roots[0].children[0].zone.name).toBe('Header');
      expect(tree.roots[0].children[0].children).toHaveLength(1);
      expect(tree.roots[0].children[0].children[0].zone.name).toBe('Banner');
    });

    it('should get full path from root', async () => {
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Articles',
      });
      await page.save();

      const section = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page.id,
        name: 'Sidebar',
      });
      await section.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: section.id,
        name: 'Ad Slot',
      });
      await slot.save();

      const fullPath = await slot.getFullPath();
      expect(fullPath).toBe('Articles > Sidebar > Ad Slot');
    });

    it('should get depth in hierarchy', async () => {
      const page = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page',
      });
      await page.save();

      const section = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page.id,
        name: 'Section',
      });
      await section.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: section.id,
        name: 'Slot',
      });
      await slot.save();

      expect(await page.getDepth()).toBe(0);
      expect(await section.getDepth()).toBe(1);
      expect(await slot.getDepth()).toBe(2);
    });
  });

  describe('Dimensions', () => {
    it('should track dimensions', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Leaderboard',
        width: 728,
        height: 90,
      });

      expect(zone.hasDimensions()).toBe(true);
      expect(zone.getDimensionString()).toBe('728x90');
    });

    it('should handle null dimensions', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Fluid Zone',
      });

      expect(zone.hasDimensions()).toBe(false);
      expect(zone.getDimensionString()).toBeNull();
    });

    it('should find zones by dimensions', async () => {
      await (
        await zones.create({
          propertyId: testProperty.id as string,
          name: 'Leaderboard 1',
          width: 728,
          height: 90,
        })
      ).save();

      await (
        await zones.create({
          propertyId: testProperty.id as string,
          name: 'Medium Rectangle',
          width: 300,
          height: 250,
        })
      ).save();

      await (
        await zones.create({
          propertyId: testProperty.id as string,
          name: 'Leaderboard 2',
          width: 728,
          height: 90,
        })
      ).save();

      const leaderboards = await zones.findByDimensions(
        testProperty.id as string,
        728,
        90,
      );
      expect(leaderboards).toHaveLength(2);
    });
  });

  describe('Allowed Formats', () => {
    it('should check if format is allowed', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Ad Slot',
        allowedFormats: ['leaderboard', 'medium-rectangle'],
      });

      expect(zone.isFormatAllowed('leaderboard')).toBe(true);
      expect(zone.isFormatAllowed('skyscraper')).toBe(false);
    });

    it('should allow all formats when none specified', async () => {
      const zone = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Unrestricted',
        allowedFormats: [],
      });

      expect(zone.isFormatAllowed('anything')).toBe(true);
    });
  });

  describe('Move Operations', () => {
    it('should move zone to new parent', async () => {
      const page1 = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page 1',
      });
      await page1.save();

      const page2 = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Page 2',
      });
      await page2.save();

      const slot = await zones.create({
        propertyId: testProperty.id as string,
        parentId: page1.id,
        name: 'Slot',
      });
      await slot.save();

      // Move slot to page2
      await zones.moveZone(slot.id as string, page2.id as string);

      const loaded = await zones.get({ id: slot.id });
      expect(loaded?.parentId).toBe(page2.id);
    });

    it('should prevent circular references', async () => {
      const parent = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Parent',
      });
      await parent.save();

      const child = await zones.create({
        propertyId: testProperty.id as string,
        parentId: parent.id,
        name: 'Child',
      });
      await child.save();

      // Try to move parent into child (would create cycle)
      await expect(
        zones.moveZone(parent.id as string, child.id as string),
      ).rejects.toThrow('Cannot move zone into one of its descendants');
    });
  });

  describe('Delete with Cascade', () => {
    it('should delete zone and promote children', async () => {
      const parent = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Parent',
      });
      await parent.save();

      const child = await zones.create({
        propertyId: testProperty.id as string,
        parentId: parent.id,
        name: 'Child',
      });
      await child.save();

      const grandchild = await zones.create({
        propertyId: testProperty.id as string,
        parentId: child.id,
        name: 'Grandchild',
      });
      await grandchild.save();

      // Delete child without cascade - grandchild should be promoted
      await zones.deleteZone(child.id as string, false);

      const loadedGrandchild = await zones.get({ id: grandchild.id });
      expect(loadedGrandchild?.parentId).toBe(parent.id);
    });

    it('should delete zone and cascade to children', async () => {
      const parent = await zones.create({
        propertyId: testProperty.id as string,
        name: 'Parent',
      });
      await parent.save();

      const child1 = await zones.create({
        propertyId: testProperty.id as string,
        parentId: parent.id,
        name: 'Child 1',
      });
      await child1.save();

      const child2 = await zones.create({
        propertyId: testProperty.id as string,
        parentId: parent.id,
        name: 'Child 2',
      });
      await child2.save();

      // Delete parent with cascade
      const deleted = await zones.deleteZone(parent.id as string, true);
      expect(deleted).toBe(3); // parent + 2 children

      const loadedChild1 = await zones.get({ id: child1.id });
      const loadedChild2 = await zones.get({ id: child2.id });
      expect(loadedChild1).toBeNull();
      expect(loadedChild2).toBeNull();
    });
  });
});
