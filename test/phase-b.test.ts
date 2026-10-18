import { describe, expect, it } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { ForgejoClientProvider } from '../src/credentials.js';
import { ActionRegistry } from '../src/registry.js';

// #16 Phase B — the governed Agent development loop. These exercise the two new
// Actions (`getPullRequestContext`, `guardedMergePullRequest`) at the Action
// layer against a ROUTED fetch mock, so every guarded-merge fail-closed branch
// is proven without a live Forgejo. The named-surface exposure and the immutable
// Checkpoint identities are covered in checkpoints.test.ts / service.test.ts.

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const registry = new ActionRegistry(buildActionCatalog());

interface Routes {
  pull?: Record<string, unknown>;
  /** The pull returned on the SECOND `/pulls/{index}` read (getPullRequestContext's recheck). */
  pullRecheck?: Record<string, unknown>;
  /** When set, bare `/pulls/{index}` reads consume this sequence in order (last entry repeats). */
  pullSequence?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  /** When set, `/reviews` returns a FULL page for every page — exhausts the guard's page cap. */
  saturateReviews?: boolean;
  protection?: Record<string, unknown> | { status: 404 };
  status?: Record<string, unknown>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch mock that routes Forgejo requests by method + path and records the merge POST body. */
function routedClient(routes: Routes) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let barePullReads = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    let body: unknown;
    if (method === 'POST') { try { body = await req.clone().json(); } catch { /* none */ } }
    calls.push({ method, path, body });
    if (method === 'POST' && path.endsWith('/merge')) return json({}, 200);
    if (path.endsWith('/reviews')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      // Forgejo v15 caps a list response at MAX_RESPONSE_ITEMS (50) regardless
      // of the requested limit, so the mock returns at most 50 per page — a
      // short-of-requested page that is NOT the end of the list.
      const serverPage = Math.min(limit, 50);
      if (routes.saturateReviews) {
        return json(Array.from({ length: serverPage }, (_, i) => ({ id: (page - 1) * serverPage + i, state: 'COMMENT', commit_id: HEAD, user: { login: `r${(page - 1) * serverPage + i}` }, submitted_at: '2026-01-01T00:00:00Z' })));
      }
      const list = routes.reviews ?? [];
      return json(list.slice((page - 1) * serverPage, page * serverPage));
    }
    if (path.includes('/branch_protections/')) {
      if (!routes.protection || 'status' in routes.protection) return json({ message: 'not found' }, 404);
      return json(routes.protection);
    }
    if (path.endsWith('/status')) return json(routes.status ?? { state: '', total_count: 0, statuses: [] });
    if (/\/pulls\/\d+$/.test(path)) {
      barePullReads += 1;
      if (routes.pullSequence?.length) {
        return json(routes.pullSequence[Math.min(barePullReads - 1, routes.pullSequence.length - 1)]);
      }
      return json((barePullReads >= 2 ? routes.pullRecheck : undefined) ?? routes.pull ?? {});
    }
    if (/\/pulls\/\d+\/(files|commits)$/.test(path)) return json([]);
    return json({ message: `unrouted ${method} ${path}` }, 500);
  }) as unknown as typeof fetch;
  const provider = new ForgejoClientProvider(
    { id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } }, fetchImpl,
  );
  const run = (name: string, input: Record<string, unknown>) => {
    const action = registry.get(name)!;
    return action.execute(registry.validate(name, input), { client: provider.forProfile(action.credentialProfile) });
  };
  return { run, calls };
}

const openMergeablePull = { number: 5, state: 'open', merged: false, mergeable: true,
  head: { ref: 'work', sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) }, html_url: 'u' };
const approvedAtHead = [{ id: 1, state: 'APPROVED', commit_id: HEAD, user: { login: 'reviewer' }, submitted_at: '2026-01-02T00:00:00Z' }];
const mergeInput = (extra: Record<string, unknown> = {}) => ({
  owner: 'o', repo: 'r', index: 5, expectedHeadRevision: HEAD, strategy: 'squash', reason: 'ship the reviewed change', ...extra,
});
const mergedMerge = (calls: Array<{ path: string }>) => calls.some((c) => c.path.endsWith('/merge'));

describe('guardedMergePullRequest — the only governed merge, fails closed (#16 §5)', () => {
  it('merges when open + mergeable + approved-at-head + no request-changes, binding head_commit_id and never force-merging', async () => {
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews: approvedAtHead });
    const out = await run('guardedMergePullRequest', mergeInput());
    expect(out.merged).toBe(true);
    expect(out.mergedHeadRevision).toBe(HEAD);
    expect(out.approvingReviewers).toEqual(['reviewer']);
    const merge = calls.find((c) => c.path.endsWith('/merge'))!;
    expect(merge.body).toMatchObject({ Do: 'squash', head_commit_id: HEAD, force_merge: false, delete_branch_after_merge: false });
  });

  it('refuses a stale approval — a HEAD change invalidates prior revision-bound review evidence (DoD)', async () => {
    // The approval is bound to OLD_HEAD; the current head is HEAD.
    const stale = [{ id: 1, state: 'APPROVED', commit_id: OLD_HEAD, user: { login: 'reviewer' }, submitted_at: '2026-01-01T00:00:00Z' }];
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews: stale });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/no approving review is bound to the current head/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('refuses a blocking request-changes even when another head-bound approval exists', async () => {
    const reviews = [
      { id: 1, state: 'APPROVED', commit_id: HEAD, user: { login: 'a' }, submitted_at: '2026-01-02T00:00:00Z' },
      { id: 2, state: 'REQUEST_CHANGES', commit_id: HEAD, user: { login: 'b' }, submitted_at: '2026-01-02T00:00:00Z' },
    ];
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/blocking request-changes/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('a later COMMENT does not clear an earlier request-changes — decisions only (#17 review 3066 P1)', async () => {
    const reviews = [
      { id: 1, state: 'REQUEST_CHANGES', commit_id: HEAD, user: { login: 'b' }, submitted_at: '2026-01-01T00:00:00Z' },
      { id: 2, state: 'COMMENT', commit_id: HEAD, user: { login: 'b' }, submitted_at: '2026-01-02T00:00:00Z' },
      { id: 3, state: 'APPROVED', commit_id: HEAD, user: { login: 'a' }, submitted_at: '2026-01-03T00:00:00Z' },
    ];
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/blocking request-changes.*b/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('a later APPROVED from the same reviewer clears their request-changes', async () => {
    const reviews = [
      { id: 1, state: 'REQUEST_CHANGES', commit_id: HEAD, user: { login: 'a' }, submitted_at: '2026-01-01T00:00:00Z' },
      { id: 2, state: 'APPROVED', commit_id: HEAD, user: { login: 'a' }, submitted_at: '2026-01-02T00:00:00Z' },
    ];
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews });
    await run('guardedMergePullRequest', mergeInput());
    expect(mergedMerge(calls)).toBe(true);
  });

  it('a platform-dismissed request-changes no longer blocks', async () => {
    const reviews = [
      { id: 1, state: 'REQUEST_CHANGES', commit_id: HEAD, dismissed: true, user: { login: 'b' }, submitted_at: '2026-01-02T00:00:00Z' },
      { id: 2, state: 'APPROVED', commit_id: HEAD, user: { login: 'a' }, submitted_at: '2026-01-01T00:00:00Z' },
    ];
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews });
    await run('guardedMergePullRequest', mergeInput());
    expect(mergedMerge(calls)).toBe(true);
  });

  it('reads ALL review pages past a short server page — a later blocking request-changes is not missed (v15 MAX_RESPONSE_ITEMS fail-open regression, #17 review 3067)', async () => {
    // 100 head-bound approvals + one blocker at index 100. The server pages at
    // 50 (v15 default) even though we request 100, so the blocker lands on
    // page 3. Terminating on a short-of-requested page (50<100) would stop at
    // page 1 and wrongly merge.
    const reviews = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: i, state: 'APPROVED', commit_id: HEAD, user: { login: `a${i}` }, submitted_at: '2026-01-02T00:00:00Z' })),
      { id: 100, state: 'REQUEST_CHANGES', commit_id: HEAD, user: { login: 'blocker' }, submitted_at: '2026-01-02T00:00:00Z' },
    ];
    const { run, calls } = routedClient({ pull: openMergeablePull, reviews });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/blocking request-changes.*blocker/);
    expect(mergedMerge(calls)).toBe(false);
    // proof it paged past the short first page to reach the blocker on page 3
    expect(calls.filter((c) => c.path.endsWith('/reviews')).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses rather than deciding on a partial review history when the page cap is exhausted', async () => {
    const { run, calls } = routedClient({ pull: openMergeablePull, saturateReviews: true });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/more reviews than the guarded merge can exhaustively read/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('a later approval by the same reviewer supersedes an earlier request-changes', async () => {
    const reviews = [
      { id: 1, state: 'REQUEST_CHANGES', commit_id: OLD_HEAD, user: { login: 'r' }, submitted_at: '2026-01-01T00:00:00Z' },
      { id: 2, state: 'APPROVED', commit_id: HEAD, user: { login: 'r' }, submitted_at: '2026-01-02T00:00:00Z' },
    ];
    const { run } = routedClient({ pull: openMergeablePull, reviews });
    const out = await run('guardedMergePullRequest', mergeInput());
    expect(out.merged).toBe(true);
  });

  it('refuses when the PR is not open / already merged', async () => {
    const { run, calls } = routedClient({ pull: { ...openMergeablePull, state: 'closed' }, reviews: approvedAtHead });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/not open and unmerged/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('refuses when the head does not match the expected revision', async () => {
    const { run, calls } = routedClient({ pull: { ...openMergeablePull, head: { ref: 'work', sha: OLD_HEAD } }, reviews: approvedAtHead });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/expected revision/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('refuses when the PR is not mergeable', async () => {
    const { run, calls } = routedClient({ pull: { ...openMergeablePull, mergeable: false }, reviews: approvedAtHead });
    await expect(run('guardedMergePullRequest', mergeInput())).rejects.toThrow(/not mergeable/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('refuses when a caller-declared required status check is not success', async () => {
    const { run, calls } = routedClient({
      pull: openMergeablePull, reviews: approvedAtHead,
      status: { state: 'pending', statuses: [{ context: 'ci/build', status: 'pending' }] },
    });
    await expect(run('guardedMergePullRequest', mergeInput({ requiredStatusChecks: ['ci/build'] })))
      .rejects.toThrow(/required status check "ci\/build" is not success/);
    expect(mergedMerge(calls)).toBe(false);
  });

  it('refuses when a required status check is missing entirely', async () => {
    const { run } = routedClient({
      pull: openMergeablePull, reviews: approvedAtHead,
      status: { state: 'success', statuses: [{ context: 'ci/other', status: 'success' }] },
    });
    await expect(run('guardedMergePullRequest', mergeInput({ requiredStatusChecks: ['ci/build'] })))
      .rejects.toThrow(/is not success \(state=missing\)/);
  });

  it('merges when the required checks (caller + protected base) are all success', async () => {
    const { run } = routedClient({
      pull: openMergeablePull, reviews: approvedAtHead,
      protection: { enable_status_check: true, status_check_contexts: ['ci/test'] },
      status: { state: 'success', statuses: [{ context: 'ci/build', status: 'success' }, { context: 'ci/test', status: 'success' }] },
    });
    const out = await run('guardedMergePullRequest', mergeInput({ requiredStatusChecks: ['ci/build'] }));
    expect(out.merged).toBe(true);
    expect(out.requiredChecks).toMatchObject({ contexts: ['ci/build', 'ci/test'], protectionReadable: true, verified: true });
  });
});

describe('getPullRequestContext — the fresh decision snapshot (#16 §1)', () => {
  it('reports identity, head/base revisions, reviews with a stale flag, and verification', async () => {
    const reviews = [
      { id: 1, state: 'APPROVED', commit_id: HEAD, user: { login: 'fresh' }, submitted_at: '2026-01-02T00:00:00Z' },
      { id: 2, state: 'APPROVED', commit_id: OLD_HEAD, user: { login: 'stale' }, submitted_at: '2026-01-01T00:00:00Z' },
    ];
    const client = routedClient({
      pull: openMergeablePull, reviews,
      status: { state: 'success', total_count: 1, statuses: [{ context: 'ci/build', status: 'success', target_url: 't' }] },
    });
    const ctx = await client.run('getPullRequestContext', { owner: 'o', repo: 'r', index: 5 });
    expect(ctx.head).toMatchObject({ branch: 'work', revision: HEAD });
    expect(ctx.base).toMatchObject({ branch: 'main' });
    expect(ctx.mergeable).toBe(true);
    const byReviewer = new Map((ctx.reviews as Array<{ reviewer: string; stale: boolean }>).map((r) => [r.reviewer, r.stale]));
    expect(byReviewer.get('fresh')).toBe(false);
    expect(byReviewer.get('stale')).toBe(true);
    expect(ctx.verification).toMatchObject({ state: 'success', available: true });
    // stable head across the read window ⇒ coherent
    expect(ctx.revisionCoherent).toBe(true);
    expect(ctx.verifiedHeadRevision).toBe(HEAD);
  });

  it('flags reviewsTruncated=true honestly when a full server page hides more — not by returned length (#17 review 3067)', async () => {
    // 60 reviews with a 50-item server page: page 1 returns 50 (< the requested
    // 100), which must NOT read as "not truncated". The page-2 probe proves more.
    const reviews = Array.from({ length: 60 }, (_, i) => ({ id: i, state: 'COMMENT', commit_id: HEAD, user: { login: `r${i}` }, submitted_at: '2026-01-01T00:00:00Z' }));
    const client = routedClient({ pull: openMergeablePull, reviews });
    const ctx = await client.run('getPullRequestContext', { owner: 'o', repo: 'r', index: 5 });
    expect((ctx.reviews as unknown[]).length).toBe(50); // the bounded first server page
    expect(ctx.reviewsTruncated).toBe(true);
  });

  it('retries once when the head moves mid-read, then returns the settled snapshot (#17 review 3066 P2)', async () => {
    const moved = { ...openMergeablePull, head: { ref: 'work', sha: OLD_HEAD } };
    // attempt 1: read HEAD, recheck sees OLD_HEAD (incoherent); attempt 2:
    // both reads see the settled OLD_HEAD and the snapshot anchors there.
    const client = routedClient({ pullSequence: [openMergeablePull, moved, moved, moved], reviews: [] });
    const ctx = await client.run('getPullRequestContext', { owner: 'o', repo: 'r', index: 5 });
    expect(ctx.head).toMatchObject({ revision: OLD_HEAD });
    expect(ctx.verifiedHeadRevision).toBe(OLD_HEAD);
    expect(ctx.revisionCoherent).toBe(true);
  });

  it('fails closed when the head keeps moving across every snapshot attempt — a mixed snapshot is never returned (#17 review 3066 P2)', async () => {
    const moved = { ...openMergeablePull, head: { ref: 'work', sha: OLD_HEAD } };
    const client = routedClient({
      pullSequence: [openMergeablePull, moved, openMergeablePull, moved],
      reviews: [],
    });
    await expect(client.run('getPullRequestContext', { owner: 'o', repo: 'r', index: 5 }))
      .rejects.toThrow(/head moved during every snapshot read window/);
  });
});
