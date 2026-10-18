/**
 * The list-first reads (panel-ce#193 #3, owner 2026-09-06) against a fake
 * Forgejo: organizations and repositories answer the list-as-console shape,
 * only PROVEN-public rows, and rows carry what the next read needs.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { ForgejoClientProvider } from '../src/credentials.js';

const repo = (owner: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: 1, name, full_name: `${owner}/${name}`, owner: { login: owner }, private: false, internal: false, fork: false,
  default_branch: 'main', html_url: `https://f/${owner}/${name}`, updated_at: '2026-09-06T00:00:00Z', description: 'd', ...extra,
});
const fetchImpl = vi.fn(async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/v1/orgs?') || url.endsWith('/api/v1/orgs')) return json([{ name: 'acme', full_name: 'ACME', description: 'x', visibility: 'public' }, { name: 'hidden', full_name: 'H', visibility: 'private' }]);
  if (url.endsWith('/api/v1/user')) return json({ login: 'me', full_name: 'Me', visibility: 'private' });
  if (url.includes('/api/v1/user/orgs')) return json([{ name: 'acme', full_name: 'ACME', visibility: 'public' }, { name: 'hidden', full_name: 'H', visibility: 'private' }]);
  if (url.includes('/api/v1/user/repos')) return json([repo('acme', 'site'), repo('hidden', 'vault', { private: true })]);
  if (url.includes('/api/v1/orgs/acme/repos')) return json([repo('acme', 'site'), repo('acme', 'docs')]);
  if (url.includes('/api/v1/orgs/hidden/repos')) return json([repo('hidden', 'vault', { private: true })]);
  if (url.includes('/api/v1/orgs/someone/repos')) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/v1/users/someone/repos')) return json([repo('someone', 'personal')]);
  if (url.includes('/api/v1/repos/acme/site')) return json(repo('acme', 'site'));
  if (url.includes('/api/v1/repos/hidden/vault')) return json(repo('hidden', 'vault', { private: true }));
  if (url.includes('/api/v1/repos/search')) return json({ ok: true, data: [repo('acme', 'site'), repo('m1ops', 'm1-demo'), repo('acme', 'secret', { private: true }), repo('acme', 'staff', { internal: true })] });
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
});
const client = new ForgejoClientProvider({ id: 'svc', baseUrl: 'https://f', credentials: { collaboration: 'tok' } }, fetchImpl as unknown as typeof fetch).forProfile('collaboration');
const action = (name: string) => buildActionCatalog().find((a) => a.name === name)!;

describe('list-first reads', () => {
  it('listOrganizations: ONE list of everything the credential can see, visibility marked with colours, each row leading to its repositories (owner 2026-09-06)', async () => {
    const out = await action('listOrganizations').execute({}, { client }) as { organizations: { name: string; kind: string; visibility: string }[]; list: { data: unknown[]; pageSize: number; columns: { key: string; format?: string; colors?: Record<string, string> }[]; rowActions: { action: string; payload: unknown }[] } };
    // organizations first, then the credential's user and every user owning a visible repository (panel-ce#193 #11)
    expect(out.organizations.map((o) => [o.name, o.kind, o.visibility])).toEqual([['acme', 'organization', 'public'], ['hidden', 'organization', 'private'], ['me', 'user', 'private']]);
    expect(out.list.data).toHaveLength(3);
    expect(out.list.pageSize).toBe(30);
    expect(out.list.columns.find((c) => c.key === 'visibility')).toMatchObject({ format: 'status', colors: { public: 'green', private: 'orange' } });
    expect(out.list.rowActions[0]).toMatchObject({ action: 'listRepositories', payload: { owners: ['$row.name'] } });
  });

  it('listRepositories: ONE list of everything the credential can see (/user/repos), visibility marked, owner carried into the Get row action; owners filter the page', async () => {
    fetchImpl.mockClear();
    const all = await action('listRepositories').execute({}, { client }) as { repositories: { fullName: string; owner: string; visibility: string }[]; list: { rowActions: { action: string; payload: Record<string, string>; lockFields?: string[] }[] } };
    expect(all.repositories.map((r) => [r.fullName, r.visibility])).toEqual([['acme/site', 'public'], ['hidden/vault', 'private']]);
    expect(all.repositories[1]).toMatchObject({ owner: 'hidden' });
    expect(all.list.rowActions[0]).toMatchObject({ action: 'getRepository', payload: { owner: '$row.owner', repo: '$row.name' }, lockFields: ['owner', 'repo'] });
    const acme = await action('listRepositories').execute({ owners: ['acme'] }, { client }) as { owners?: string[]; repositories: { fullName: string }[]; list: { filters: { field: string; options: { value: string }[] }[] } };
    expect(acme.owners).toEqual(['acme']);
    expect(acme.list.filters[0]).toMatchObject({ field: 'owners', multiple: true });
    expect(acme.list.filters[0]!.options.map((o) => o.value)).toEqual(['acme', 'hidden']);
    expect(acme.repositories.map((r) => r.fullName)).toEqual(['acme/site', 'acme/docs']); // per-owner listing, not a page filter
    // Choices = every organization the credential can see, not only the owners on one page.
    expect(acme.list.filters[0]!.options.map((o) => o.value)).toEqual(['acme', 'hidden']);
    const user = await action('listRepositories').execute({ owners: ['someone'] }, { client }) as { repositories: { fullName: string }[] };
    expect(user.repositories.map((r) => r.fullName)).toEqual(['someone/personal']); // a user owner falls back to /users/{name}/repos
    const urls = fetchImpl.mock.calls.map((c) => (c[0] instanceof Request ? c[0].url : String(c[0])));
    expect(urls.filter((u) => u.includes('/user/repos'))).toHaveLength(1); // only the unfiltered read
    expect(urls.some((u) => u.includes('/repos/search'))).toBe(false);
  });
});
