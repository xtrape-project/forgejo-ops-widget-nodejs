import type { ActionDefinition, CheckpointMetadata } from './types.js';
import { WidgetActionError } from './errors.js';

const OWNER_REPO = {
  owner: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository owner — the user or organization name as it appears in the repository URL (e.g. "m1ops" in m1ops/m1-demo).' },
  repo: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository name as it appears in the URL (e.g. "m1-demo" in m1ops/m1-demo), without the owner.' },
} as const;
const PAGE = {
  page: { type: 'integer', minimum: 1, default: 1, description: 'Page number, starting at 1.' },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 30, description: 'Items per page (1–100).' },
} as const;

/** The owner filter of the list-first repository reads: choose many, or none for all. */
const OWNERS_FILTER = {
  type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 50, uniqueItems: true,
  title: 'Owners (organizations or users)',
  description: 'Owners (organization or user names) to list repositories of; empty = every repository the credential can see. The list offers the owners it found as choices.',
} as const;
export function ownersOf(input: Record<string, unknown>): string[] {
  const raw = input.owners;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
  return [...new Set(list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
}
export function ownerOptions(repos: ReadonlyArray<{ owner?: { login?: string } | null }>): { value: string; label: string }[] {
  return [...new Set(repos.map((r) => r.owner?.login ?? '').filter((x) => x !== ''))].sort().map((v) => ({ value: v, label: v }));
}

/** Visibility tag colours the Panel renders (owner 2026-09-06: public and private in different colours). */
export const VISIBILITY_COLORS = { public: 'green', private: 'orange', internal: 'gold', limited: 'gold', unknown: 'default' } as const;
export function visibilityOf(r: { private?: boolean; internal?: boolean }): 'public' | 'private' | 'internal' {
  return r.private ? 'private' : (r as { internal?: boolean }).internal ? 'internal' : 'public';
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function int(input: Record<string, unknown>, key: string, fallback?: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function inspectCheckpoint(id: string, resourceType: string): CheckpointMetadata {
  return {
    id,
    version: '1.0.0',
    resourceType,
    risk: 'low',
    sideEffect: 'none',
    credentialProfile: 'collaboration',
    localPreconditions: ['schema-valid'],
  };
}

function data<T>(response: { data?: T }): T {
  if (response.data === undefined) throw new Error('Forgejo returned no response data');
  return response.data;
}

export function buildInspectionActions(): ActionDefinition[] {
  return [
    {
      // LIST-FIRST (owner 2026-09-06, panel-ce#193 #3): with the credential
      // configured the Widget knows which Forgejo and whose identity — so the
      // first act, for a person and for an AI host alike, is a LIST, never a
      // hand-typed owner/repo. Organizations → Repositories → the reads.
      //
      // ONE list, the same for Panel and Exposure (owner 2026-09-06): every
      // organization the credential can see, visibility MARKED per row
      // (public green / private orange) rather than split into two Actions.
      // Owner's classification ruling: this listing metadata (names,
      // visibility, one-line description) is INTERNAL — what an operator's
      // credential may enumerate — not CONFIDENTIAL content.
      name: 'listOrganizations', version: '1.0.0', label: 'List Organizations and Users',
      description: 'List every repository owner the collaboration credential can see — organizations and users, with type and visibility (public / private) — the starting point for browsing repositories.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.organization.list', 'forgejo.organization'),
      inputSchema: schema(PAGE, []),
      async execute(input, { client, signal }) {
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const opts = signal ? { signal } : {};
        const orgs = data(await client.GET('/user/orgs', { params: { query: { page, limit } }, ...opts }));
        // OWNERS, not only organizations (panel-ce#193 #11, owner 2026-09-06: a
        // repository was listed but its owner was not — m1ops is a USER). A
        // repository's owner is an organization or a user; both are listed,
        // with the kind marked, so every visible repository has its owner here.
        const rows = orgs.map((o) => ({ name: o.name ?? '', kind: 'organization', fullName: o.full_name, description: o.description, visibility: o.visibility ?? 'unknown' }));
        const seen = new Set(rows.map((r) => r.name));
        // The credential's own user, and every user that owns a visible repository.
        try {
          const me = data(await client.GET('/user', opts));
          if (me.login && !seen.has(me.login)) { seen.add(me.login); rows.push({ name: me.login, kind: 'user', fullName: me.full_name, description: me.description, visibility: me.visibility ?? 'unknown' }); }
        } catch { /* a token without read:user: the repository owners below still name the user */ }
        const repos = data(await client.GET('/user/repos', { params: { query: { page: 1, limit: 100 } }, ...opts }));
        for (const r of repos) {
          const o = r.owner; const login = o?.login ?? '';
          if (!login || seen.has(login)) continue;
          seen.add(login);
          rows.push({ name: login, kind: 'user', fullName: o?.full_name, description: o?.description, visibility: o?.visibility ?? 'unknown' });
        }
        return {
          page, limit, organizations: rows,
          list: {
            title: 'Organizations and users',
            data: rows,
            pageSize: limit,
            columns: [
              { key: 'name', label: 'Owner', format: 'code', copyable: true },
              { key: 'kind', label: 'Type', format: 'status', colors: { organization: 'blue', user: 'purple' } },
              { key: 'fullName', label: 'Full name' },
              { key: 'visibility', label: 'Visibility', format: 'status', colors: VISIBILITY_COLORS },
              { key: 'description', label: 'Description', ellipsis: true },
            ],
            rowActions: [{ label: 'Repositories', action: 'listRepositories', submitLabel: 'List', payload: { owners: ['$row.name'] }, showResult: true }],
            pageActions: [{ label: 'All repositories', action: 'listRepositories', submitLabel: 'List', payload: {}, showResult: true }],
          },
        };
      },
    },
    {
      name: 'listRepositories', version: '1.0.0', label: 'List Repositories',
      description: 'List every repository the collaboration credential can see, with its visibility (public / private) — all of them, or those of chosen owners. Each row leads to the repository reads; nothing has to be typed.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.repository.list', 'forgejo.repository'),
      inputSchema: schema({ owners: OWNERS_FILTER, ...PAGE }, []),
      async execute(input, { client, signal }) {
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const owners = ownersOf(input);
        // OWNERS CHOSEN → per-owner listing (`/orgs/{org}/repos`, falling back
        // to `/users/{user}/repos`): exact, paged per owner, not a filter over
        // one page of `/user/repos` (panel-ce#193 #8). NO owners → `/user/repos`,
        // what the credential can see (needs `read:user`).
        const opts = signal ? { signal } : {};
        const found = owners.length
          ? (await Promise.all(owners.map(async (owner) => {
              // The client throws on a non-2xx: an owner that is not an
              // organization (404) is read as a user.
              try {
                return data(await client.GET('/orgs/{org}/repos', { params: { path: { org: owner }, query: { page, limit } }, ...opts }));
              } catch {
                return data(await client.GET('/users/{username}/repos', { params: { path: { username: owner }, query: { page, limit } }, ...opts }));
              }
            }))).flat()
          : data(await client.GET('/user/repos', { params: { query: { page, limit } }, ...opts }));
        const repositories = found.map((repository) => ({
            id: repository.id, owner: repository.owner?.login ?? (repository.full_name ?? '').split('/')[0], name: repository.name, fullName: repository.full_name,
            visibility: visibilityOf(repository), description: repository.description, fork: repository.fork, defaultBranch: repository.default_branch,
            url: repository.html_url, updatedAt: repository.updated_at,
          }));
        // The facet's CHOICES are the organizations the credential can see
        // (every page of `/user/orgs`, bounded) plus the owners on this page —
        // not just the owners that happened to be on one page (panel-ce#193 #8).
        const choiceSet = new Set<string>(found.map((r) => r.owner?.login ?? '').filter((x) => x !== ''));
        for (let p = 1; p <= 10; p += 1) {
          const orgs = await client.GET('/user/orgs', { params: { query: { page: p, limit: 50 } }, ...opts });
          const names = (orgs.data ?? []).map((o) => o.name ?? '').filter((x) => x !== '');
          names.forEach((n) => choiceSet.add(n));
          if (names.length < 50) break;
        }
        const ownerChoices = [...choiceSet].sort().map((v) => ({ value: v, label: v }));
        return {
          page, limit, ...(owners.length ? { owners } : {}), repositories,
          list: {
            title: owners.length ? `Repositories of ${owners.join(', ')}` : 'Repositories',
            pageSize: limit,
            // The FILTER facet (panel-ce#193 #5): the choices come from this
            // same read — the owners on the page — so the console offers a
            // selection (many, or all) instead of a box to type into.
            filters: [{ field: 'owners', label: 'Owners (organizations or users)', multiple: true, allLabel: 'All', options: ownerChoices }],
            data: repositories,
            columns: [
              { key: 'fullName', label: 'Repository', format: 'code', copyable: true },
              { key: 'visibility', label: 'Visibility', format: 'status', colors: VISIBILITY_COLORS },
              { key: 'defaultBranch', label: 'Default branch', format: 'code' },
              { key: 'fork', label: 'Fork', format: 'boolean' },
              { key: 'description', label: 'Description', ellipsis: true },
              { key: 'updatedAt', label: 'Updated' },
            ],
            rowActions: [
              { label: 'Get', action: 'getRepository', submitLabel: 'Get', lockFields: ['owner', 'repo'], payload: { owner: '$row.owner', repo: '$row.name' }, showResult: true },
              { label: 'Issues', action: 'listIssues', submitLabel: 'List', lockFields: ['owner', 'repo'], payload: { owner: '$row.owner', repo: '$row.name' }, showResult: true },
              { label: 'Pull requests', action: 'listPullRequests', submitLabel: 'List', lockFields: ['owner', 'repo'], payload: { owner: '$row.owner', repo: '$row.name' }, showResult: true },
            ],
            pageActions: [],
          },
        };
      },
    },
    {
      name: 'listTags', version: '1.0.0', label: 'List Tags',
      description: 'List repository tags and their commit revisions.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.tag.list', 'forgejo.tag'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const tags = data(await client.GET('/repos/{owner}/{repo}/tags', {
          params: { path: { owner, repo }, query: { page, limit } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, page, limit, tags: tags.map((tag) => ({
          name: tag.name, revision: tag.commit?.sha ?? tag.id,
        })) };
      },
    },
    {
      name: 'listCommits', version: '1.0.0', label: 'List Commits',
      description: 'List repository commits, optionally bounded to a revision and path.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.commit.list', 'forgejo.commit'),
      inputSchema: schema({
        ...OWNER_REPO, ...PAGE,
        sha: { type: 'string', minLength: 1, maxLength: 255 },
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
      }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const path = typeof input.path === 'string' ? input.path : undefined;
        const commits = data(await client.GET('/repos/{owner}/{repo}/commits', {
          params: { path: { owner, repo }, query: { page, limit, ...(sha ? { sha } : {}), ...(path ? { path } : {}) } },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, page, limit, commits: commits.map((commit) => ({
          revision: commit.sha, message: commit.commit?.message,
          author: commit.author?.login ?? commit.commit?.author?.name,
          authoredAt: commit.commit?.author?.date, url: commit.html_url,
        })) };
      },
    },
    {
      name: 'getCommit', version: '1.0.0', label: 'Get Commit',
      description: 'Read one repository commit by immutable revision.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.commit.get', 'forgejo.commit'),
      inputSchema: schema({ ...OWNER_REPO, sha: { type: 'string', minLength: 1, maxLength: 255 } }, ['owner', 'repo', 'sha']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const sha = string(input, 'sha');
        const commit = data(await client.GET('/repos/{owner}/{repo}/git/commits/{sha}', {
          params: { path: { owner, repo, sha } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, revision: commit.sha,
          author: commit.author?.login, committer: commit.committer?.login,
          createdAt: commit.created, url: commit.html_url ?? commit.url };
      },
    },
    {
      name: 'listTree', version: '1.0.0', label: 'List Git Tree',
      description: 'List a repository tree at an explicit revision.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.tree.list', 'forgejo.git-tree'),
      inputSchema: schema({ ...OWNER_REPO, sha: { type: 'string', minLength: 1, maxLength: 255 }, recursive: { type: 'boolean', default: false } }, ['owner', 'repo', 'sha']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const sha = string(input, 'sha');
        const recursive = input.recursive === true;
        const tree = data(await client.GET('/repos/{owner}/{repo}/git/trees/{sha}', {
          params: { path: { owner, repo, sha }, query: { recursive } }, ...(signal ? { signal } : {}),
        }));
        const allEntries = tree.tree ?? [];
        const entries = allEntries.slice(0, 5_000);
        return { owner, repo, revision: tree.sha, truncated: tree.truncated === true || allEntries.length > entries.length,
          truncatedByWidget: allEntries.length > entries.length, entries: entries.map((entry) => ({
          path: entry.path, type: entry.type, mode: entry.mode, size: entry.size, revision: entry.sha,
        })) };
      },
    },
    {
      name: 'getFile', version: '1.0.0', label: 'Get File',
      description: 'Read one UTF-8 repository file at an explicit revision, bounded to 1 MiB decoded output.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.file.get', 'forgejo.file'),
      inputSchema: schema({
        ...OWNER_REPO, filepath: { type: 'string', minLength: 1, maxLength: 4_096 },
        ref: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['owner', 'repo', 'filepath', 'ref']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const filepath = string(input, 'filepath'); const ref = string(input, 'ref');
        const raw = data(await client.GET('/repos/{owner}/{repo}/contents/{filepath}', {
          params: { path: { owner, repo, filepath }, query: { ref } }, ...(signal ? { signal } : {}),
        }));
        if (Array.isArray(raw)) throw new Error('requested path is a directory; use listTree');
        const file = raw;
        if (file.type !== 'file' || typeof file.content !== 'string') throw new Error('requested path is not a readable file');
        const content = Buffer.from(file.content.replace(/\n/g, ''), 'base64');
        if (content.byteLength > 1_048_576) throw new Error('file exceeds the 1 MiB decoded output limit');
        return { owner, repo, path: file.path, name: file.name, revision: file.sha,
          size: file.size, encoding: 'utf-8', content: content.toString('utf8'), url: file.html_url };
      },
    },
    {
      name: 'listIssues', version: '1.0.0', label: 'List Issues',
      description: 'List repository issues with bounded pagination and state filters.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.issue.list', 'forgejo.issue'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, state: { enum: ['open', 'closed', 'all'], default: 'open', title: 'State', description: 'Which issues: open, closed, or all.' } }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const state = typeof input.state === 'string' ? input.state as 'open' | 'closed' | 'all' : 'open';
        const issues = data(await client.GET('/repos/{owner}/{repo}/issues', {
          params: { path: { owner, repo }, query: { page, limit, state, type: 'issues' } }, ...(signal ? { signal } : {}),
        }));
        const rows = issues.map((issue) => ({
          owner, repo, index: issue.number, title: issue.title, state: issue.state, url: issue.html_url,
          labels: issue.labels?.map((label) => label.name), updatedAt: issue.updated_at,
        }));
        // List-as-console (panel-ce#193 #9): reached from a repository row,
        // each issue row leads to getIssue with owner / repo / number carried.
        return { owner, repo, page, limit, issues: rows, list: {
          title: `Issues of ${owner}/${repo}`, pageSize: limit, data: rows,
          columns: [
            { key: 'index', label: 'Number', format: 'code' },
            { key: 'title', label: 'Title', ellipsis: true },
            { key: 'state', label: 'State', format: 'status', colors: { open: 'green', closed: 'default' } },
            { key: 'updatedAt', label: 'Updated' },
          ],
          rowActions: [{ label: 'Get', action: 'getIssue', submitLabel: 'Get', lockFields: ['owner', 'repo', 'index'], payload: { owner: '$row.owner', repo: '$row.repo', index: '$row.index' }, showResult: true }],
          pageActions: [],
        } };
      },
    },
    {
      name: 'listLabels', version: '1.0.0', label: 'List Repository Labels',
      description: 'List repository label definitions with bounded pagination.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.label.list', 'forgejo.label'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE,
        sort: { enum: ['mostissues', 'leastissues', 'reversealphabetically'] },
      }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const sort = typeof input.sort === 'string' ? input.sort as 'mostissues' | 'leastissues' | 'reversealphabetically' : undefined;
        const labels = data(await client.GET('/repos/{owner}/{repo}/labels', {
          params: { path: { owner, repo }, query: { page, limit, ...(sort ? { sort } : {}) } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, page, limit, labels: labels.map((label) => ({ id: label.id, name: label.name,
          color: label.color, description: label.description, exclusive: label.exclusive, archived: label.is_archived })) };
      },
    },
    {
      name: 'getLabel', version: '1.0.0', label: 'Get Repository Label',
      description: 'Read one repository label definition by immutable numeric ID.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.label.get', 'forgejo.label'),
      inputSchema: schema({ ...OWNER_REPO, id: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'id']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const label = data(await client.GET('/repos/{owner}/{repo}/labels/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: label.id, name: label.name, color: label.color, description: label.description,
          exclusive: label.exclusive, archived: label.is_archived };
      },
    },
    {
      name: 'listMilestones', version: '1.0.0', label: 'List Milestones',
      description: 'List repository milestones with bounded pagination and state filtering.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.milestone.list', 'forgejo.milestone'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, state: { enum: ['open', 'closed', 'all'], default: 'open' },
        name: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const state = typeof input.state === 'string' ? input.state : 'open';
        const name = typeof input.name === 'string' ? input.name : undefined;
        const milestones = data(await client.GET('/repos/{owner}/{repo}/milestones', {
          params: { path: { owner, repo }, query: { page, limit, state, ...(name ? { name } : {}) } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, page, limit, milestones: milestones.map((milestone) => ({ id: milestone.id,
          title: milestone.title, description: milestone.description, state: milestone.state, dueOn: milestone.due_on,
          openIssues: milestone.open_issues, closedIssues: milestone.closed_issues, updatedAt: milestone.updated_at })) };
      },
    },
    {
      name: 'getMilestone', version: '1.0.0', label: 'Get Milestone',
      description: 'Read one repository milestone by immutable numeric ID.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.milestone.get', 'forgejo.milestone'),
      inputSchema: schema({ ...OWNER_REPO, id: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'id']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const milestone = data(await client.GET('/repos/{owner}/{repo}/milestones/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: milestone.id, title: milestone.title, description: milestone.description,
          state: milestone.state, dueOn: milestone.due_on, openIssues: milestone.open_issues,
          closedIssues: milestone.closed_issues, createdAt: milestone.created_at, updatedAt: milestone.updated_at };
      },
    },
    {
      name: 'listReleases', version: '1.0.0', label: 'List Releases',
      description: 'List repository release records with bounded pagination and explicit draft/prerelease filters.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.release.list', 'forgejo.release'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, includeDrafts: { type: 'boolean', default: false },
        includePrereleases: { type: 'boolean', default: true }, query: { type: 'string', maxLength: 255 },
      }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const query = typeof input.query === 'string' ? input.query : undefined;
        const releases = data(await client.GET('/repos/{owner}/{repo}/releases', {
          params: { path: { owner, repo }, query: { page, limit, draft: input.includeDrafts === true,
            'pre-release': input.includePrereleases !== false, ...(query ? { q: query } : {}) } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, page, limit, releases: releases.map((release) => ({ id: release.id, tag: release.tag_name,
          target: release.target_commitish, title: release.name, draft: release.draft, prerelease: release.prerelease,
          createdAt: release.created_at, publishedAt: release.published_at, url: release.html_url })) };
      },
    },
    {
      name: 'getRelease', version: '1.0.0', label: 'Get Release',
      description: 'Read one repository release record by immutable numeric ID.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.release.get', 'forgejo.release'),
      inputSchema: schema({ ...OWNER_REPO, id: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'id']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const release = data(await client.GET('/repos/{owner}/{repo}/releases/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: release.id, tag: release.tag_name, target: release.target_commitish,
          title: release.name, body: release.body, draft: release.draft, prerelease: release.prerelease,
          createdAt: release.created_at, publishedAt: release.published_at, url: release.html_url };
      },
    },
    {
      name: 'listIssueComments', version: '1.0.0', label: 'List Issue Comments',
      description: 'List comments for one issue or pull request conversation.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.issue-comment.list', 'forgejo.issue-comment'),
      inputSchema: schema({
        ...OWNER_REPO, index: { type: 'integer', minimum: 1 },
        since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' }, before: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
      }, ['owner', 'repo', 'index']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const since = typeof input.since === 'string' ? input.since : undefined;
        const before = typeof input.before === 'string' ? input.before : undefined;
        const comments = data(await client.GET('/repos/{owner}/{repo}/issues/{index}/comments', {
          params: { path: { owner, repo, index }, query: { ...(since ? { since } : {}), ...(before ? { before } : {}) } },
          ...(signal ? { signal } : {}),
        }));
        const bounded = comments.slice(0, 100);
        return { owner, repo, index, truncatedByWidget: comments.length > bounded.length, comments: bounded.map((comment) => ({
          id: comment.id, body: comment.body, author: comment.user?.login,
          createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url,
        })) };
      },
    },
    {
      name: 'listPullRequests', version: '1.0.0', label: 'List Pull Requests',
      description: 'List repository pull requests with bounded pagination and state filters.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.pull-request.list', 'forgejo.pull-request'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, state: { enum: ['open', 'closed', 'all'], default: 'open', title: 'State', description: 'Which pull requests: open, closed, or all.' } }, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const state = typeof input.state === 'string' ? input.state as 'open' | 'closed' | 'all' : 'open';
        const pulls = data(await client.GET('/repos/{owner}/{repo}/pulls', {
          params: { path: { owner, repo }, query: { page, limit, state } }, ...(signal ? { signal } : {}),
        }));
        const rows = pulls.map((pull) => ({
          owner, repo, index: pull.number, title: pull.title, state: pull.state, draft: pull.draft,
          author: pull.user?.login, head: { branch: pull.head?.ref, revision: pull.head?.sha },
          base: { branch: pull.base?.ref, revision: pull.base?.sha }, url: pull.html_url, updatedAt: pull.updated_at,
        }));
        return { owner, repo, page, limit, pullRequests: rows, list: {
          title: `Pull requests of ${owner}/${repo}`, pageSize: limit, data: rows,
          columns: [
            { key: 'index', label: 'Number', format: 'code' },
            { key: 'title', label: 'Title', ellipsis: true },
            { key: 'state', label: 'State', format: 'status', colors: { open: 'green', closed: 'default' } },
            { key: 'author', label: 'Author', format: 'code' },
            { key: 'head.branch', label: 'Source branch', format: 'code' },
            { key: 'updatedAt', label: 'Updated' },
          ],
          rowActions: [
            { label: 'Get', action: 'getPullRequest', submitLabel: 'Get', lockFields: ['owner', 'repo', 'index'], payload: { owner: '$row.owner', repo: '$row.repo', index: '$row.index' }, showResult: true },
            { label: 'Context', action: 'getPullRequestContext', submitLabel: 'Get', lockFields: ['owner', 'repo', 'index'], payload: { owner: '$row.owner', repo: '$row.repo', index: '$row.index' }, showResult: true },
          ],
          pageActions: [],
        } };
      },
    },
    {
      name: 'listPullRequestFiles', version: '1.0.0', label: 'List Pull Request Files',
      description: 'List changed files and bounded change statistics for one pull request.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.pull-request-file.list', 'forgejo.pull-request-file'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, index: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'index']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const files = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/files', {
          params: { path: { owner, repo, index }, query: { page, limit } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index, page, limit, files: files.map((file) => ({
          path: file.filename, previousPath: file.previous_filename, status: file.status,
          additions: file.additions, deletions: file.deletions, changes: file.changes,
        })) };
      },
    },
    {
      name: 'listPullRequestCommits', version: '1.0.0', label: 'List Pull Request Commits',
      description: 'List commits currently contained in one pull request.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.pull-request-commit.list', 'forgejo.commit'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, index: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'index']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const commits = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/commits', {
          params: { path: { owner, repo, index }, query: { page, limit } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index, page, limit, commits: commits.map((commit) => ({
          revision: commit.sha, message: commit.commit?.message, author: commit.author?.login ?? commit.commit?.author?.name,
          authoredAt: commit.commit?.author?.date, url: commit.html_url,
        })) };
      },
    },
    {
      name: 'listPullRequestReviews', version: '1.0.0', label: 'List Pull Request Reviews',
      description: 'List submitted and pending reviews for one pull request.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.pull-request-review.list', 'forgejo.pull-request-review'),
      inputSchema: schema({ ...OWNER_REPO, ...PAGE, index: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'index']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const page = int(input, 'page', 1); const limit = int(input, 'limit', 30);
        const reviews = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/reviews', {
          params: { path: { owner, repo, index }, query: { page, limit } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index, page, limit, reviews: reviews.map((review) => ({
          id: review.id, state: review.state, body: review.body,
          reviewer: review.user?.login, submittedAt: review.submitted_at, url: review.html_url,
        })) };
      },
    },
    {
      // #16 §1 — the FRESH decision snapshot. A review/fix/merge decision needs
      // one coherent, revision-anchored view rather than a hand-assembled set of
      // raw REST reads. This composes the identity, the exact head/base
      // revisions, mergeability, the changed files and commits, the reviews with
      // their bound commit_id (so STALE review evidence is visible as such
      // against the current head), and the head's combined check state. It is a
      // READ: it mutates nothing.
      name: 'getPullRequestContext', version: '1.0.0', label: 'Get Pull Request Context',
      description: 'Establish the fresh decision snapshot for one pull request: identity, exact head/base revisions, state and mergeability, changed files, commits, reviews bound to their commit revision (with a stale flag against the current head), and the head commit\'s combined verification state.',
      capability: 'forgejo.inspect', credentialProfile: 'collaboration',
      checkpoint: inspectCheckpoint('forgejo.inspect.pull-request.context.get', 'forgejo.pull-request'),
      inputSchema: schema({ ...OWNER_REPO, index: { type: 'integer', minimum: 1, description: 'The pull request number shown in Forgejo (the N in /pulls/N).' } }, ['owner', 'repo', 'index']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const opts = signal ? { signal } : {};
        // Revision coherence is a GATE, not an advisory flag (#17 review 3066):
        // a snapshot whose sub-reads straddle a head move mixes revisions and
        // must never be returned as success. One bounded retry re-reads the
        // whole window from scratch (a racing push usually settles); if the
        // head is still moving, fail closed and let the caller re-invoke.
        const MAX_SNAPSHOT_ATTEMPTS = 2;
        let movedFrom: string | undefined; let movedTo: string | undefined;
        for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
        const pull = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } }, ...opts,
        }));
        const headRevision = pull.head?.sha;
        // The bounded first pages: a decision snapshot is not a full-history
        // export. Each list returns the first server page and reports whether
        // more remain. Truncation CANNOT be inferred from the returned length
        // (Forgejo caps a response at MAX_RESPONSE_ITEMS, 50 by default in v15,
        // independent of the requested limit — a full 50-item page is not the
        // end, #17 review 3067), so it is proven by probing whether a second
        // page (same limit) has any item.
        const files = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/files', {
          params: { path: { owner, repo, index }, query: { page: 1, limit: 100 } }, ...opts,
        }));
        const filesTruncated = files.length > 0 && data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/files', {
          params: { path: { owner, repo, index }, query: { page: 2, limit: 100 } }, ...opts,
        })).length > 0;
        const commits = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/commits', {
          params: { path: { owner, repo, index }, query: { page: 1, limit: 100 } }, ...opts,
        }));
        const commitsTruncated = commits.length > 0 && data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/commits', {
          params: { path: { owner, repo, index }, query: { page: 2, limit: 100 } }, ...opts,
        })).length > 0;
        const reviews = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/reviews', {
          params: { path: { owner, repo, index }, query: { page: 1, limit: 100 } }, ...opts,
        }));
        const reviewsTruncated = reviews.length > 0 && data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/reviews', {
          params: { path: { owner, repo, index }, query: { page: 2, limit: 100 } }, ...opts,
        })).length > 0;
        // The head's combined check state. A repository with no CI returns an
        // empty combined status; that is a fact of the snapshot, not an error,
        // so a transport failure here (e.g. the ref not yet indexed) degrades to
        // an explicit `unknown` rather than failing the whole read.
        let verification: { state: string | undefined; totalCount: number; checks: Array<{ context: string | undefined; state: string | undefined; targetUrl: string | undefined }>; available: boolean };
        try {
          const status = headRevision
            ? data(await client.GET('/repos/{owner}/{repo}/commits/{ref}/status', {
                params: { path: { owner, repo, ref: headRevision } }, ...opts,
              }))
            : { state: undefined, total_count: 0, statuses: [] };
          verification = {
            state: status.state,
            totalCount: status.total_count ?? (status.statuses?.length ?? 0),
            checks: (status.statuses ?? []).slice(0, 100).map((s) => ({ context: s.context, state: s.status, targetUrl: s.target_url })),
            available: true,
          };
        } catch {
          verification = { state: undefined, totalCount: 0, checks: [], available: false };
        }
        // Revision coherence: these sub-reads are NOT one atomic snapshot —
        // Forgejo's files/commits/reviews/status endpoints always reflect the
        // CURRENT head, so a push landing mid-read would mix revisions. Re-read
        // the head and require that it held across the whole window; an
        // incoherent window restarts the attempt loop above and, once attempts
        // are exhausted, fails closed instead of returning mixed data.
        const recheck = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } }, ...opts,
        }));
        const verifiedHeadRevision = recheck.head?.sha;
        const revisionCoherent = headRevision !== undefined && verifiedHeadRevision === headRevision;
        if (!revisionCoherent) {
          movedFrom = headRevision; movedTo = verifiedHeadRevision;
          continue;
        }
        return {
          owner, repo, index: pull.number,
          revisionCoherent, verifiedHeadRevision,
          title: pull.title, state: pull.state, url: pull.html_url,
          draft: pull.draft, merged: pull.merged, mergeable: pull.mergeable,
          author: pull.user?.login,
          head: { branch: pull.head?.ref, revision: headRevision },
          base: { branch: pull.base?.ref, revision: pull.base?.sha },
          updatedAt: pull.updated_at,
          changedFiles: files.map((file) => ({
            path: file.filename, previousPath: file.previous_filename, status: file.status,
            additions: file.additions, deletions: file.deletions, changes: file.changes,
          })),
          changedFilesTruncated: filesTruncated,
          commits: commits.map((commit) => ({
            revision: commit.sha, message: commit.commit?.message,
            author: commit.author?.login ?? commit.commit?.author?.name, authoredAt: commit.commit?.author?.date,
          })),
          commitsTruncated,
          // Each review carries the revision it was bound to; `stale` marks the
          // ones no longer anchored to the current head — the single fact a
          // guarded merge must not treat as satisfying evidence (#16 §5).
          reviews: reviews.map((review) => ({
            id: review.id, state: review.state, reviewer: review.user?.login,
            commitId: review.commit_id, stale: headRevision !== undefined && review.commit_id !== headRevision,
            submittedAt: review.submitted_at,
          })),
          reviewsTruncated,
          verification,
        };
        }
        throw new WidgetActionError(
          'PRECONDITION_FAILED',
          `pull request head moved during every snapshot read window (${String(movedFrom)} -> ${String(movedTo)}); a mixed-revision snapshot is never returned — retry once the head settles`,
        );
      },
    },
  ];
}
