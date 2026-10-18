import { describe, expect, it, vi } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { ForgejoClientProvider } from '../src/credentials.js';
import { ActionRegistry } from '../src/registry.js';
import type { ActionDefinition } from '../src/types.js';

function action(name: string, fetchImpl: typeof fetch): { definition: ActionDefinition; execute(input: Record<string, unknown>): Promise<Record<string, unknown>> } {
  const registry = new ActionRegistry(buildActionCatalog());
  const clients = new ForgejoClientProvider({
    id: 'default', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'ordinary-token' },
  }, fetchImpl);
  const definition = registry.get(name);
  if (!definition) throw new Error(`missing catalog Action ${name}`);
  return {
    definition,
    execute(input) {
      return definition.execute(registry.validate(name, input), { client: clients.forProfile(definition.credentialProfile) });
    },
  };
}

describe('dormant mutation migration inventory', () => {
  it('does not retry non-idempotent issue creation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message: 'unavailable' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    const create = action('createIssue', fetchImpl);
    await expect(create.execute({ owner: 'xtrape', repo: 'repo', title: 'Title', body: 'Body', reason: 'handoff' })).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('checks the source branch revision before creating a branch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      name: 'main', commit: { id: 'current-revision' }, protected: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const create = action('createBranch', fetchImpl);
    await expect(create.execute({
      owner: 'xtrape', repo: 'repo', sourceBranch: 'main', newBranch: 'work',
      expectedSourceRevision: 'stale-revision', reason: 'start work',
    })).rejects.toThrow(/expected revision/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('denies protected-branch file mutation before the write request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      name: 'main', commit: { id: 'revision' }, protected: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const create = action('createFile', fetchImpl);
    await expect(create.execute({
      owner: 'xtrape', repo: 'repo', branch: 'main', expectedBranchRevision: 'revision',
      path: 'README.md', content: 'text', message: 'docs: add readme', reason: 'document project',
    })).rejects.toThrow(/protected branch/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('checks pull-request head revision before submitting a review', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      number: 3, title: 'PR', state: 'open', head: { sha: 'new-head' }, base: { sha: 'base' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const review = action('reviewPullRequest', fetchImpl);
    await expect(review.execute({
      owner: 'xtrape', repo: 'repo', index: 3, event: 'APPROVE', body: '',
      expectedHeadRevision: 'reviewed-head', reason: 'review complete',
    })).rejects.toThrow(/expected revision/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps the public APPROVE event to Forgejo APPROVED', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const parsed = new Request(request);
      if (parsed.method === 'GET') {
        return new Response(JSON.stringify({
          number: 3, state: 'open', merged: false, head: { sha: 'reviewed-head' }, base: { sha: 'base' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(await parsed.json()).toMatchObject({ event: 'APPROVED', commit_id: 'reviewed-head' });
      return new Response(JSON.stringify({ id: 12, state: 'APPROVED', body: '', user: { login: 'reviewer' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const review = action('reviewPullRequest', fetchImpl);
    await expect(review.execute({ owner: 'xtrape', repo: 'repo', index: 3, event: 'APPROVE', body: '',
      expectedHeadRevision: 'reviewed-head', reason: 'review complete' })).resolves.toMatchObject({ state: 'APPROVED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('checks issue updated-at before changing its state', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      number: 7, title: 'Issue', state: 'open', updated_at: '2026-08-14T10:00:00Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const update = action('setIssueState', fetchImpl);
    await expect(update.execute({ owner: 'xtrape', repo: 'repo', index: 7, state: 'closed',
      expectedUpdatedAt: '2026-08-14T09:00:00Z', reason: 'issue resolved' })).rejects.toThrow(/expected revision/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects malformed atomic file operations before reaching Forgejo', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const commit = action('atomicCommitFiles', fetchImpl);
    await expect(commit.execute({ owner: 'xtrape', repo: 'repo', branch: 'work', expectedBranchRevision: 'head',
      message: 'feat: atomic change', reason: 'apply reviewed edits', files: [
        { operation: 'update', path: 'README.md', content: 'new' },
      ] })).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces aggregate atomic content size before reaching Forgejo', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const commit = action('atomicCommitFiles', fetchImpl);
    const large = 'x'.repeat(1_048_576);
    await expect(commit.execute({ owner: 'xtrape', repo: 'repo', branch: 'work', expectedBranchRevision: 'head',
      message: 'feat: atomic change', reason: 'apply reviewed edits', files: [
        { operation: 'create', path: 'a.txt', content: large },
        { operation: 'create', path: 'b.txt', content: large },
        { operation: 'create', path: 'c.txt', content: 'x' },
      ] })).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
