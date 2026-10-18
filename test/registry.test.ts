import { describe, expect, it } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { ActionRegistry } from '../src/registry.js';

describe('ActionRegistry', () => {
  it('has one unique owner for every Action and Checkpoint', () => {
    const definitions = buildActionCatalog();
    const registry = new ActionRegistry(definitions);
    expect(registry.list()).toHaveLength(60);
    expect(new Set(definitions.map((action) => action.name)).size).toBe(definitions.length);
    expect(new Set(definitions.map((action) => action.checkpoint.id)).size).toBe(definitions.length);
  });

  it('rejects duplicate Action ownership', () => {
    const action = buildActionCatalog()[0];
    expect(action).toBeDefined();
    expect(() => new ActionRegistry([action!, action!])).toThrow(/duplicate Action owner/);
  });

  it('rejects duplicate Checkpoint ownership', () => {
    const [first, second] = buildActionCatalog();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(() => new ActionRegistry([first!, { ...second!, checkpoint: first!.checkpoint }])).toThrow(/duplicate Checkpoint owner/);
  });

  it('rejects caller attempts to inject authority or credentials', () => {
    const registry = new ActionRegistry(buildActionCatalog());
    expect(() => registry.validate('getRepository', {
      owner: 'xtrape',
      repo: 'docs',
      authorized: true,
      credentialProfile: 'administration',
    })).toThrow(/additional properties/);
  });

  it('never assigns an administration credential to ordinary Actions', () => {
    const ordinary = buildActionCatalog().filter((action) =>
      ['forgejo.inspect', 'forgejo.collaborate', 'forgejo.content'].includes(action.capability));
    expect(ordinary.every((action) => action.credentialProfile === 'collaboration')).toBe(true);
  });
});
