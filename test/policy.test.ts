import { describe, expect, it } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { assertExpectedRevision, assertWritableBranch, locallyAvailable } from '../src/policy.js';
import type { ActionDefinition } from '../src/types.js';

describe('narrowing-only local policy', () => {
  it('never publishes a mutation before canonical Checkpoint transport exists', () => {
    const base = buildActionCatalog()[0]!;
    const destructive: ActionDefinition = {
      ...base,
      name: 'deleteRepository',
      credentialProfile: 'administration',
      checkpoint: {
        ...base.checkpoint,
        id: 'forgejo.governance.repository.delete',
        sideEffect: 'destructive',
        risk: 'critical',
        credentialProfile: 'administration',
      },
    };
    expect(destructive.checkpoint.sideEffect).toBe('destructive');
    expect(locallyAvailable()).toBe(false);
  });

  it('also suppresses read Actions because Resource authorization is unavailable', () => {
    const action = buildActionCatalog()[0]!;
    expect(action.checkpoint.sideEffect).toBe('none');
    expect(locallyAvailable()).toBe(false);
  });

  it('fails closed on protected branches and stale revisions', () => {
    expect(() => assertWritableBranch(true)).toThrow(/protected branch/);
    expect(() => assertExpectedRevision('current', 'expected')).toThrow(/does not match/);
    expect(() => assertExpectedRevision('same', 'same')).not.toThrow();
  });
});
