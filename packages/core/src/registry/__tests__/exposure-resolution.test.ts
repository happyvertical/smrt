/**
 * `resolveModelExposure`: one pure resolution of a model's generated
 * surfaces (api/mcp/cli) over a lookup the caller supplies. Order per
 * surface: the node's own value or what it inherits; then rulings against
 * every parent (narrowing is free, widening beyond a parent needs a
 * `widenParentExposure` grant, a whole-surface close also closes the node's
 * own methods unless granted); then the open default. The manifest and
 * runtime adapters build on it; the read-time gate passes inherit/restrict
 * parents and a cap hook.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type ExposureLookup,
  type ExposureParents,
  type ModelExposure,
  resolveModelExposure,
} from '../exposure-resolution';
import {
  inheritSubclassExposure,
  surfaceOpensOperation,
} from '../subclass-exposure';
import type { SmartObjectConfig } from '../types';

interface Node {
  name: string;
  config: SmartObjectConfig;
  parents?: Node | ExposureParents<Node>;
  ops?: string[];
}

const lookup: ExposureLookup<Node> = {
  ownConfig: (node) => node.config,
  parentOf: (node) => node.parents,
  operationsOf: (node) => node.ops ?? [],
};

const node = (
  name: string,
  config: SmartObjectConfig,
  parents?: Node | ExposureParents<Node>,
  ops?: string[],
): Node => ({ name, config, parents, ops });

describe('one inherit parent (the adapters)', () => {
  it('a surface the node leaves unset is inherited as a copy', () => {
    const parent = node('P', {
      api: { include: ['list', 'get'] },
      sensitive: true,
    });
    const child = node('C', {}, parent);
    const result = resolveModelExposure(child, lookup);
    expect(result.surfaces.api).toMatchObject({
      effective: { include: ['list', 'get'] },
      unclamped: { include: ['list', 'get'] },
      declared: undefined,
      source: 'inherited',
      widenedBeyondAncestor: [],
    });
    expect(result.surfaces.api.effective).not.toBe(parent.config.api);
    expect(result.config.sensitive).toBe(true);
    expect(result.surfaces.mcp).toMatchObject({
      effective: undefined,
      source: 'unset',
    });
  });

  it('matches inheritSubclassExposure for every unset/set shape (unclampedConfig is today’s value)', () => {
    const shapes: SmartObjectConfig[] = [
      {},
      { api: undefined },
      { api: false },
      { api: true },
      { api: { include: ['list'] }, mcp: false },
      { cli: { exclude: ['delete'] }, sensitive: true },
      {
        api: { include: ['list', 'get'], routes: { x: { method: 'GET' } } },
      } as SmartObjectConfig,
    ];
    for (const parentConfig of shapes) {
      for (const childConfig of shapes) {
        const child = node('C', childConfig, node('P', parentConfig));
        const expected = {
          ...childConfig,
          ...inheritSubclassExposure(childConfig, parentConfig),
        };
        const actual = resolveModelExposure(child, lookup).unclampedConfig;
        expect(actual).toEqual(expected);
        // Own keys too: an explicitly present `undefined` surface stays a key.
        expect(Object.keys(actual).sort()).toEqual(
          Object.keys(expected).sort(),
        );
      }
    }
  });

  it('unclamped values inherit from the parent’s unclamped value, not its clamped one', () => {
    const root = node('R', { api: { include: ['list'] } });
    const mid = node('M', { api: { include: ['list', 'get'] } }, root);
    const leaf = node('L', {}, mid);
    const result = resolveModelExposure(leaf, lookup);
    expect(result.unclampedConfig.api).toEqual({ include: ['list', 'get'] });
    expect(result.config.api).toEqual({
      include: ['list', 'get'],
      exclude: ['get'],
    });
  });

  it('narrowing is free', () => {
    const child = node(
      'C',
      { api: { include: ['list'] } },
      node('P', { api: { include: ['list', 'get'] } }),
    );
    expect(resolveModelExposure(child, lookup).surfaces.api).toMatchObject({
      effective: { include: ['list'] },
      source: 'own',
      widenedBeyondAncestor: [],
    });
  });

  it('widening beyond the parent without a grant is clamped and reported', () => {
    const child = node(
      'C',
      { api: { include: ['list', 'get', 'create'] } },
      node('P', { api: { include: ['list', 'get'] } }),
    );
    const api = resolveModelExposure(child, lookup).surfaces.api;
    expect(api.source).toBe('clamped');
    expect(api.widenedBeyondAncestor).toEqual(['create']);
    expect(api.unclamped).toEqual({ include: ['list', 'get', 'create'] });
    expect(api.effective).toEqual({
      include: ['list', 'get', 'create'],
      exclude: ['create'],
    });
  });

  it('a widenParentExposure grant re-opens the operation', () => {
    const child = node(
      'C',
      {
        api: { include: ['list', 'get', 'create'] },
        widenParentExposure: { api: ['create'] },
      },
      node('P', { api: { include: ['list', 'get'] } }),
    );
    const api = resolveModelExposure(child, lookup).surfaces.api;
    expect(api.effective).toEqual({ include: ['list', 'get', 'create'] });
    expect(api.grantedBeyondAncestor).toEqual(['create']);
    expect(api.widenedBeyondAncestor).toEqual([]);
  });

  it('a parent method the parent closes is a widening; the node’s own method under a specific close stays open (rule b, ii)', () => {
    const parent = node('P', { mcp: { exclude: ['archive'] } }, undefined, [
      'archive',
    ]);
    const child = node('C', { mcp: true }, parent, ['archive', 'stamp']);
    const mcp = resolveModelExposure(child, lookup).surfaces.mcp;
    expect(mcp.widenedBeyondAncestor).toEqual(['archive']);
    expect(mcp.effective).toEqual({ exclude: ['archive'] });
  });

  it('a whole-surface close also closes the node’s own methods unless granted (rule b, i)', () => {
    const parent = node('P', { mcp: false });
    const closed = node('C', { mcp: { include: ['list', 'stamp'] } }, parent, [
      'stamp',
    ]);
    expect(resolveModelExposure(closed, lookup).surfaces.mcp).toMatchObject({
      effective: false,
      source: 'clamped',
      widenedBeyondAncestor: ['list', 'stamp'],
    });
    const granted = node(
      'C',
      {
        mcp: { include: ['list', 'stamp'] },
        widenParentExposure: { mcp: ['stamp'] },
      },
      parent,
      ['stamp'],
    );
    expect(resolveModelExposure(granted, lookup).surfaces.mcp).toMatchObject({
      effective: { include: ['stamp'] },
      widenedBeyondAncestor: ['list'],
      grantedBeyondAncestor: ['stamp'],
    });
  });

  it('dropping a parent’s sensitive is refused at read time', () => {
    const child = node(
      'C',
      { sensitive: false },
      node('P', { sensitive: true }),
    );
    const result = resolveModelExposure(child, lookup);
    expect(result.config.sensitive).toBe(true);
    expect(result.unclampedConfig.sensitive).toBe(false);
  });

  it('resolves grandparents first and survives a cycle', () => {
    const root = node('R', { cli: false });
    const mid = node('M', {}, root);
    const leaf = node('L', {}, mid);
    expect(resolveModelExposure(leaf, lookup).surfaces.cli.effective).toBe(
      false,
    );
    const a = node('A', { api: { include: ['list'] } });
    const b = node('B', {}, a);
    a.parents = b;
    expect(() => resolveModelExposure(b, lookup)).not.toThrow();
  });

  it('a whole-surface close with a CRUD-only grant opens only the grant, on every surface', () => {
    for (const surface of ['api', 'mcp', 'cli'] as const) {
      const parent = node('P', { [surface]: false });
      const child = node(
        'C',
        { [surface]: true, widenParentExposure: { [surface]: ['list'] } },
        parent,
        ['publish'],
      );
      const resolved = resolveModelExposure(child, lookup).surfaces[surface];
      expect(resolved.grantedBeyondAncestor).toEqual(['list']);
      for (const operation of [
        'list',
        'get',
        'create',
        'update',
        'delete',
        'publish',
      ]) {
        expect(
          surfaceOpensOperation(surface, resolved.effective, operation),
          `${surface} ${operation}`,
        ).toBe(operation === 'list');
      }
    }
  });

  it('an operation a grandparent declares and a parent closes stays closed below it', () => {
    const grandparent = node('G', {}, undefined, ['archive']);
    const parent = node('P', { mcp: { exclude: ['archive'] } }, grandparent);
    const child = node('C', { mcp: true }, parent);
    const mcp = resolveModelExposure(child, lookup).surfaces.mcp;
    expect(mcp.widenedBeyondAncestor).toEqual(['archive']);
    expect(surfaceOpensOperation('mcp', mcp.effective, 'archive')).toBe(false);
    // A lookup that reports no operations still rules on what a parent closes.
    const bare: ExposureLookup<Node> = {
      ownConfig: (n) => n.config,
      parentOf: (n) => n.parents,
    };
    const bareMcp = resolveModelExposure(child, bare).surfaces.mcp;
    expect(surfaceOpensOperation('mcp', bareMcp.effective, 'archive')).toBe(
      false,
    );
  });

  it('a shared memo answers a cycle the same whichever member is resolved first', () => {
    const cycle = () => {
      const a = node('A', { api: false });
      const b = node('B', {}, a);
      a.parents = b;
      return { a, b };
    };
    const fresh = cycle();
    const alone = {
      a: resolveModelExposure(fresh.a, lookup).surfaces.api.effective,
      b: resolveModelExposure(fresh.b, lookup).surfaces.api.effective,
    };
    expect(alone).toEqual({ a: false, b: false });
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const nodes = cycle();
      const memo = new Map<Node, ModelExposure>();
      for (const name of order) {
        expect(
          resolveModelExposure(nodes[name], lookup, memo).surfaces.api
            .effective,
          `${order.join(' then ')}: ${name}`,
        ).toBe(alone[name]);
      }
    }
  });
});

const OPS = ['list', 'get', 'create', 'update', 'delete'];
const bareLookup: ExposureLookup<Node> = {
  ownConfig: (n) => n.config,
  parentOf: (n) => n.parents,
};

describe('round-2 clamp cases', () => {
  it('a CRUD-only CLI grant under a whole close never opens an operation the candidate already closed', () => {
    const parent = node('P', { cli: false });
    const child = node(
      'C',
      {
        cli: { include: ['list', 'preview'] },
        widenParentExposure: { cli: ['list'] },
      },
      parent,
      ['preview', 'publish'],
    );
    const cli = resolveModelExposure(child, lookup).surfaces.cli;
    for (const operation of [...OPS, 'preview', 'publish'])
      expect(
        surfaceOpensOperation('cli', cli.effective, operation),
        operation,
      ).toBe(operation === 'list');
  });

  it('a whole close with a CRUD-only CLI grant stays closed one level down, with and without operationsOf', () => {
    const parent = node('P', { cli: false });
    const child = node(
      'C',
      { cli: true, widenParentExposure: { cli: ['list'] } },
      parent,
    );
    // The grandchild inherits the child's value and declares its own method.
    const inheriting = node('G', {}, child, ['ship']);
    const declaring = node('H', { cli: true }, child, ['ship']);
    for (const [name, look] of [
      ['with operationsOf', lookup],
      ['without operationsOf', bareLookup],
    ] as const) {
      for (const grandchild of [inheriting, declaring]) {
        const cli = resolveModelExposure(grandchild, look).surfaces.cli;
        for (const operation of [...OPS, 'ship'])
          expect(
            surfaceOpensOperation('cli', cli.effective, operation),
            `${name} ${grandchild.name} ${operation}`,
          ).toBe(false);
      }
    }
    // A grandchild that grants the operation itself re-opens only that one.
    const granting = node(
      'K',
      { widenParentExposure: { cli: ['list'] } },
      child,
      ['ship'],
    );
    const cli = resolveModelExposure(granting, lookup).surfaces.cli;
    for (const operation of [...OPS, 'ship'])
      expect(
        surfaceOpensOperation('cli', cli.effective, operation),
        operation,
      ).toBe(operation === 'list');
  });

  it('without operationsOf, a grandparent method a parent withholds by a strict include stays closed', () => {
    const grandparent = node('G', {}, undefined, ['archive']);
    const parent = node(
      'P',
      { mcp: { include: ['list', 'get'] } },
      grandparent,
    );
    const child = node('C', { mcp: true }, parent);
    const mcp = resolveModelExposure(child, bareLookup).surfaces.mcp;
    expect(surfaceOpensOperation('mcp', mcp.effective, 'archive')).toBe(false);
    expect(surfaceOpensOperation('mcp', mcp.effective, 'list')).toBe(true);
    expect(surfaceOpensOperation('mcp', mcp.effective, 'create')).toBe(false);
    // The node's own enumerated method stays open under a specific close (rule b).
    const own = node('D', { mcp: true }, parent, ['stamp']);
    expect(
      surfaceOpensOperation(
        'mcp',
        resolveModelExposure(own, lookup).surfaces.mcp.effective,
        'stamp',
      ),
    ).toBe(true);
  });

  it('two capped parents sharing one result object keep their own inherited operations', () => {
    // A fixed result both capped parents receive: an MCP allowlist.
    const fixedResult: ModelExposure = {
      config: { mcp: { include: ['list', 'get'] } },
      unclampedConfig: { mcp: { include: ['list', 'get'] } },
      surfaces: {} as ModelExposure['surfaces'],
    };
    // `archive` reaches the first parent only from its own parent.
    const grandparent = node('G', {}, undefined, ['archive']);
    const first = node('A', { mcp: { include: ['list', 'get'] } }, grandparent);
    const second = node('B', {}, undefined, ['other']);
    const fixed: ExposureLookup<Node> = {
      ...lookup,
      cap: (n, resolved) =>
        n === first || n === second ? fixedResult : resolved,
    };
    const memo = new Map<Node, ModelExposure>();
    resolveModelExposure(first, fixed, memo);
    resolveModelExposure(second, fixed, memo);
    const child = node('C', { mcp: true }, first);
    const mcp = resolveModelExposure(child, fixed, memo).surfaces.mcp;
    expect(mcp.widenedBeyondAncestor).toContain('archive');
    expect(surfaceOpensOperation('mcp', mcp.effective, 'archive')).toBe(false);
  });

  it('a cycle with several inherit parents answers the same fresh and from a shared memo, in any order', () => {
    const graph = () => {
      const c = node('C', { sensitive: true });
      const a = node('A', {});
      const b = node('B', {}, a);
      a.parents = { inherit: [b, c], restrict: [] };
      return { a, b, c };
    };
    const fresh = graph();
    const alone = {
      a: resolveModelExposure(fresh.a, lookup).config.sensitive,
      b: resolveModelExposure(fresh.b, lookup).config.sensitive,
    };
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const nodes = graph();
      const memo = new Map<Node, ModelExposure>();
      for (const name of order)
        expect(
          resolveModelExposure(nodes[name], lookup, memo).config.sensitive,
          `${order.join(' then ')}: ${name}`,
        ).toBe(alone[name]);
    }
  });

  it('a lookup returning a raw exclude-all closes the surface like the adapters do', () => {
    const parent = node('P', { api: { exclude: ['*'] } });
    const child = node('C', { api: true }, parent);
    const api = resolveModelExposure(child, lookup).surfaces.api;
    for (const operation of OPS)
      expect(surfaceOpensOperation('api', api.effective, operation)).toBe(
        false,
      );
    expect(api.widenedBeyondAncestor).toEqual(OPS);
    // Granted operations re-open.
    const granted = node(
      'D',
      { api: true, widenParentExposure: { api: ['list'] } },
      parent,
    );
    const open = resolveModelExposure(granted, lookup).surfaces.api;
    expect(surfaceOpensOperation('api', open.effective, 'list')).toBe(true);
    expect(surfaceOpensOperation('api', open.effective, 'get')).toBe(false);
  });
});

describe('inherit and restrict parents (the read-time gate)', () => {
  it('two inherit parents: an operation is open only if every one opens it; options and sensitive from the first', () => {
    const first = node('F', {
      api: {
        include: ['list', 'get', 'create'],
        public: 'read',
      } as SmartObjectConfig['api'],
      sensitive: true,
    });
    const second = node('S', { api: { include: ['list', 'get'] } });
    const child = node('C', {}, { inherit: [first, second], restrict: [] });
    const result = resolveModelExposure(child, lookup);
    expect(result.surfaces.api.effective).toEqual({
      include: ['list', 'get', 'create'],
      public: 'read',
      exclude: ['create'],
    });
    expect(result.config.sensitive).toBe(true);
  });

  it('a restrict parent closes operations and contributes no options or sensitive', () => {
    const inherit = node('I', { api: { include: ['list', 'get'] } });
    const restrict = node('R', {
      api: { exclude: ['get'], public: true } as SmartObjectConfig['api'],
      mcp: false,
      sensitive: true,
    });
    const child = node('C', {}, { inherit: [inherit], restrict: [restrict] });
    const result = resolveModelExposure(child, lookup);
    expect(result.surfaces.api.effective).toEqual({
      include: ['list', 'get'],
      exclude: ['get'],
    });
    expect(result.surfaces.mcp.effective).toBe(false);
    expect(result.config.sensitive).toBeUndefined();
  });

  it('a grant re-opens what a restrict parent closes', () => {
    const restrict = node('R', { api: { exclude: ['create'] } });
    const child = node(
      'C',
      { api: true, widenParentExposure: { api: ['create'] } },
      { inherit: [], restrict: [restrict] },
    );
    expect(resolveModelExposure(child, lookup).surfaces.api).toMatchObject({
      effective: true,
      grantedBeyondAncestor: ['create'],
    });
  });

  it('a whole-surface close by a restrict parent closes the node’s own methods unless granted', () => {
    const restrict = node('R', { cli: false });
    const child = node(
      'C',
      { cli: { include: ['ping'] } },
      { inherit: [], restrict: [restrict] },
      ['ping'],
    );
    expect(resolveModelExposure(child, lookup).surfaces.cli.effective).toBe(
      false,
    );
  });
});

describe('cap hook', () => {
  it('runs once per node after resolution, before memoising; the memo keeps its result', () => {
    const parent = node('P', { api: { include: ['list'] } });
    const child = node('C', {}, parent);
    const cap = vi.fn(
      (n: Node, resolved: ModelExposure): ModelExposure =>
        n.name === 'P'
          ? {
              ...resolved,
              config: { ...resolved.config, api: false },
              surfaces: {
                ...resolved.surfaces,
                api: {
                  ...resolved.surfaces.api,
                  effective: false,
                  source: 'unidentified-ancestor',
                },
              },
            }
          : resolved,
    );
    const memo = new Map<Node, ModelExposure>();
    const result = resolveModelExposure(child, { ...lookup, cap }, memo);
    resolveModelExposure(child, { ...lookup, cap }, memo);
    expect(cap).toHaveBeenCalledTimes(2);
    expect(memo.get(parent)?.surfaces.api.source).toBe('unidentified-ancestor');
    // The child inherits the capped parent's value.
    expect(result.surfaces.api.effective).toBe(false);
  });

  it('no hook changes nothing', () => {
    const child = node('C', {}, node('P', { api: { include: ['list'] } }));
    expect(resolveModelExposure(child, lookup).surfaces.api.effective).toEqual({
      include: ['list'],
    });
  });
});
