import { describe, expect, it } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { ActionRegistry } from '../src/registry.js';
import { buildCeActions } from '../src/service.js';
import { parseBoundedCheckpoints } from '../src/checkpoints.js';
import { ForgejoClientProvider } from '../src/credentials.js';

const SERVICE_ID = 'forgejo-ops-widget-nodejs';
function fixture() {
  const registry = new ActionRegistry(buildActionCatalog());
  const provider = new ForgejoClientProvider({ id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } });
  return {
    registry,
    // the widest servable surface: the #10 writes must be NAMED (2965 P1-1)
    actions: buildCeActions({
      serviceId: SERVICE_ID,
      provider,
      bounded: parseBoundedCheckpoints('repository.get,issue.get,pull-request.get,pull-request.create,pull-request-review.create'),
    }),
  };
}

describe('governance authority boundary', () => {
  it('serves the reference reads plus the #10 write pair, never merge/administration', () => {
    const { actions } = fixture();
    const served = new Set(actions.map((a) => a.name));
    // the read trio and the #10 write pair are served...
    for (const name of ['getRepository', 'getIssue', 'getPullRequest', 'createPullRequest', 'reviewPullRequest']) {
      expect(served.has(name), name).toBe(true);
    }
    // ...and — under an allowlist that names ONLY the #10 pair — no other
    // write, no merge, nothing administrative. #16 adds Phase B writes
    // (branch/commit/issue and the GUARDED merge), but each is served only
    // when this allowlist names it, and the UNGUARDED `mergePullRequest`
    // stays dormant inventory forever.
    for (const name of ['createIssue', 'updatePullRequestMetadata', 'closePullRequest', 'createBranch', 'mergePullRequest',
      'commentIssue', 'createOrganization', 'deleteBranch', 'deleteRelease', 'deleteRepository']) {
      expect(served.has(name), name).toBe(false);
    }
  });

  it('keeps ordinary merge bound to the collaboration credential in the dormant inventory', () => {
    const definition = fixture().registry.get('mergePullRequest')!;
    expect(definition.credentialProfile).toBe('collaboration');
    expect(definition.checkpoint.credentialProfile).toBe('collaboration');
  });

  it('keeps one unique owner per Action and Checkpoint across the whole inventory', () => {
    const catalog = buildActionCatalog();
    expect(new Set(catalog.map((action) => `${action.name}@${action.version}`)).size).toBe(catalog.length);
    expect(new Set(catalog.map((action) => `${action.checkpoint.id}@${action.checkpoint.version}`)).size).toBe(catalog.length);
  });
});
