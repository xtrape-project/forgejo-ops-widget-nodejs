import { describe, expect, it } from 'vitest';
import { buildCeActions } from '../src/service.js';
import { ForgejoClientProvider } from '../src/credentials.js';
import { parseBoundedCheckpoints } from '../src/checkpoints.js';

const SERVICE_ID = 'forgejo-ops-widget-nodejs';
function provider(): ForgejoClientProvider {
  return new ForgejoClientProvider({ id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } });
}

describe('bounded governed CE Action surface (#7 reads + #10 writes)', () => {
  const ALL_FIVE = parseBoundedCheckpoints('repository.get,issue.get,pull-request.get,pull-request.create,pull-request-review.create');

  it('DEFAULT serves only the reads — every write appears only when the allowlist NAMES it (2965 P1-1, #16)', () => {
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider: provider() });
    expect(actions.map((a) => a.name).sort()).toEqual(['getIssue', 'getPullRequest', 'getPullRequestContext', 'getRepository', 'listIssues', 'listOrganizations', 'listPullRequests', 'listRepositories']);
  });

  it('serves the three reads and the two #10 writes when the allowlist names all five, each bound to its exact Checkpoint', () => {
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider: provider(), bounded: ALL_FIVE });
    expect(actions.map((a) => a.name).sort()).toEqual(['createPullRequest', 'getIssue', 'getPullRequest', 'getRepository', 'reviewPullRequest']);
    for (const action of actions) {
      expect(action.checkpoint).toMatchObject({ serviceId: SERVICE_ID });
      expect(action.inputSchema).toBeTruthy();
      expect(typeof action.execute).toBe('function');
    }
    const byName = new Map(actions.map((a) => [a.name, a.checkpoint!.checkpointId]));
    expect(byName.get('getRepository')).toBe('repository.get');
    expect(byName.get('getIssue')).toBe('issue.get');
    expect(byName.get('getPullRequest')).toBe('pull-request.get');
    expect(byName.get('createPullRequest')).toBe('pull-request.create');
    expect(byName.get('reviewPullRequest')).toBe('pull-request-review.create');
    // the read/write split is visible on the served category
    const cat = new Map(actions.map((a) => [a.name, a.category]));
    // Reads that take owner/repo are reached from a list row (panel-ce#193 #9): PUBLISHED and AI-callable, out of the operator catalog.
    expect(cat.get('getRepository')).toBe('_inspect');
    expect(cat.get('getIssue')).toBe('_inspect');
    expect(cat.get('createPullRequest')).toBe('collaborate');
    expect(cat.get('reviewPullRequest')).toBe('collaborate');
    // published read identities stay at their immutable 1.0.1; the writes start at 1.0.0
    const ver = new Map(actions.map((a) => [a.name, a.checkpoint!.checkpointVersion]));
    expect(ver.get('getRepository')).toBe('1.0.2');
    expect(ver.get('createPullRequest')).toBe('1.0.1');
  });

  it('never serves a write outside the #10 pair, and never merge / administration — even on the full allowlist', () => {
    const names = new Set(buildCeActions({ serviceId: SERVICE_ID, provider: provider(), bounded: ALL_FIVE }).map((a) => a.name));
    for (const write of ['createIssue', 'commentIssue', 'updatePullRequestMetadata', 'closePullRequest', 'createBranch', 'mergePullRequest', 'deleteBranch', 'deleteRepository']) {
      expect(names.has(write), write).toBe(false);
    }
  });

  it('every served Action binds exactly one unique Checkpoint (connector requirement)', () => {
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider: provider(), bounded: ALL_FIVE });
    const keys = actions.map((a) => `${a.checkpoint!.checkpointId}@${a.checkpoint!.checkpointVersion}`);
    expect(new Set(keys).size).toBe(actions.length);
    expect(actions.every((a) => a.checkpoint !== undefined)).toBe(true);
  });

  it('the bounded allowlist narrows the served surface to the named subset', () => {
    const bounded = parseBoundedCheckpoints('repository.get');
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider: provider(), bounded });
    expect(actions.map((a) => a.name)).toEqual(['getRepository']);
  });
});

describe('governed execute runs the FULL Action schema before any Forgejo request (2965 P1-2)', () => {
  const ALL_FIVE = parseBoundedCheckpoints('repository.get,issue.get,pull-request.get,pull-request.create,pull-request-review.create');

  function recordingProvider() {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { provider: new ForgejoClientProvider({ id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } }, fetchImpl), calls };
  }

  it('an out-of-vocabulary review event refuses BEFORE any HTTP call — the projection widened enum to string, the Widget narrows it back', async () => {
    const { provider, calls } = recordingProvider();
    const byName = new Map(buildCeActions({ serviceId: SERVICE_ID, provider, bounded: ALL_FIVE }).map((a) => [a.name, a]));
    await expect(
      byName.get('reviewPullRequest')!.execute({
        owner: 'm1ops', repo: 'm1-demo', index: 1, event: 'MERGE', expectedHeadRevision: 'a'.repeat(40), reason: 'r',
      }),
    ).rejects.toThrow(/validation failed/);
    // NOTHING left for Forgejo — not even the public-repo probe.
    expect(calls).toEqual([]);
  });

  it('a rich constraint the admitted projection dropped still refuses locally (empty title)', async () => {
    const { provider, calls } = recordingProvider();
    const byName = new Map(buildCeActions({ serviceId: SERVICE_ID, provider, bounded: ALL_FIVE }).map((a) => [a.name, a]));
    await expect(
      byName.get('createPullRequest')!.execute({
        owner: 'm1ops', repo: 'm1-demo', title: '', head: 'feat/x', base: 'main', reason: 'r',
      }),
    ).rejects.toThrow(/validation failed/);
    expect(calls).toEqual([]);
  });

  it('reads validate too: a missing required index refuses before the network', async () => {
    const { provider, calls } = recordingProvider();
    const byName = new Map(buildCeActions({ serviceId: SERVICE_ID, provider, bounded: ALL_FIVE }).map((a) => [a.name, a]));
    await expect(byName.get('getIssue')!.execute({ owner: 'm1ops', repo: 'm1-demo' })).rejects.toThrow(/validation failed/);
    expect(calls).toEqual([]);
  });
});

describe('no repository gate (#34): what the credential can see is served, and whether a write lands is the token\'s permission', () => {
  function providerWith(repoBody: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}) {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const path = new URL(url).pathname;
      if (/\/api\/v1\/repos\/[^/]+\/[^/]+$/.test(path)) {
        return new Response(JSON.stringify(repoBody), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      for (const [suffix, body] of Object.entries(extra)) {
        if (path.endsWith(suffix)) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = new ForgejoClientProvider(
      { id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } },
      fetchImpl,
    );
    return { provider, calls };
  }

  // Owner 2026-09-06: the READS open whatever the credential can see (Panel =
  // Exposure). Owner 2026-09-07 (#34): the WRITES too — whether a write may
  // land is the Forgejo token's permission, and a 403 is the refusal.
  const ALL_FIVE = parseBoundedCheckpoints('repository.get,issue.get,pull-request.get,pull-request.create,pull-request-review.create');

  it('READS and WRITES both serve a PRIVATE repository — no visibility pre-judgement, the write goes straight to Forgejo (#34)', async () => {
    const { provider, calls } = providerWith(
      { id: 1, full_name: 'm1ops/secret', private: true, internal: false },
      {
        '/issues/1': { number: 1, title: 'private issue', state: 'open', body: 'b', html_url: 'u', labels: [] },
        '/pulls/2': { number: 2, title: 'pr', state: 'open', head: { sha: 'abc', ref: 'feat' }, base: { sha: 'base', ref: 'main' }, html_url: 'u', mergeable: true },
        '/pulls/2/reviews': { id: 9, state: 'APPROVED', commit_id: 'abc', html_url: 'r' },
      },
    );
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider, bounded: new Set([...(ALL_FIVE ?? []), 'issue.get']) });
    const byName = new Map(actions.map((a) => [a.name, a]));
    const out = (await byName.get('getIssue')!.execute({ owner: 'm1ops', repo: 'secret', index: 1 })) as { success: boolean; data: Record<string, unknown> };
    expect(out.success).toBe(true);
    expect(out.data['title']).toBe('private issue');
    const reviewed = (await byName.get('reviewPullRequest')!.execute({ owner: 'm1ops', repo: 'secret', index: 2, event: 'APPROVE', expectedHeadRevision: 'abc', reason: 'r' })) as { success: boolean };
    expect(reviewed.success).toBe(true);
    // The review POST went out (no repository-visibility probe stood in its way).
    expect(calls.some((u) => /\/pulls\/2\/reviews$/.test(new URL(u).pathname))).toBe(true);
  });

  it('a write the TOKEN may not perform is refused by Forgejo (403) and surfaces as the write\'s own failure (#34)', async () => {
    const fetch403 = (async (input: string | URL | Request) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
      if (/\/api\/v1\/repos\/[^/]+\/[^/]+$/.test(path)) return new Response(JSON.stringify({ id: 1, full_name: 'm1ops/secret', private: true, internal: false }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (/\/pulls\/2$/.test(path)) return new Response(JSON.stringify({ number: 2, state: 'open', head: { sha: 'abc', ref: 'feat' }, base: { sha: 'base', ref: 'main' }, html_url: 'u', mergeable: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{"message":"user does not have write access"}', { status: 403, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const p403 = new ForgejoClientProvider({ id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } }, fetch403);
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider: p403, bounded: ALL_FIVE });
    const byName = new Map(actions.map((a) => [a.name, a]));
    await expect(byName.get('reviewPullRequest')!.execute({ owner: 'm1ops', repo: 'secret', index: 2, event: 'APPROVE', expectedHeadRevision: 'abc', reason: 'r' })).rejects.toThrow(/permission denied/);
  });

  it('serves a PUBLIC repository normally', async () => {
    const { provider } = providerWith(
      { id: 1, name: 'm1-demo', full_name: 'm1ops/m1-demo', private: false, internal: false, default_branch: 'main' },
    );
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider });
    const byName = new Map(actions.map((a) => [a.name, a]));
    const out = (await byName.get('getRepository')!.execute({ owner: 'm1ops', repo: 'm1-demo' })) as { success: boolean; data: Record<string, unknown> };
    expect(out.success).toBe(true);
    expect(out.data['fullName']).toBe('m1ops/m1-demo');
    expect(out.data['private']).toBe(false);
  });

  it('an unreadable repository refuses rather than leaking whether it exists as private', async () => {
    const { provider } = providerWith(undefined as unknown as Record<string, unknown>);
    // repo endpoint answers 404 (no JSON body match) => data undefined => refuse
    const fetch404 = (async () => new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const p404 = new ForgejoClientProvider({ id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } }, fetch404);
    const actions = buildCeActions({ serviceId: SERVICE_ID, provider: p404 });
    const byName = new Map(actions.map((a) => [a.name, a]));
    // The refusal shape may come from the client (its own 404 error) or from
    // the gate ('not readable'); the PROPERTY is that nothing proceeds.
    await expect(byName.get('getIssue')!.execute({ owner: 'x', repo: 'y', index: 1 })).rejects.toThrow();
    void provider;
  });
});
