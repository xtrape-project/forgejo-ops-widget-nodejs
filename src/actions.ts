import type { ForgejoOpenApiClient } from '@xtrape/forgejo-api';
import type { ActionDefinition, CheckpointMetadata } from './types.js';
import { buildInspectionActions } from './inspection-actions.js';
import { buildCollaborationActions } from './collaboration-actions.js';
import { buildContentActions } from './content-actions.js';
import { buildGovernanceActions } from './governance-actions.js';
import { buildAdministrationActions } from './administration-actions.js';

const OWNER_REPO_PROPERTIES = {
  owner: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository owner — the user or organization name as it appears in the repository URL (e.g. "m1ops" in m1ops/m1-demo).' },
  repo: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository name as it appears in the URL (e.g. "m1-demo" in m1ops/m1-demo), without the owner.' },
} as const;

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function integer(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function checkpoint(
  id: string,
  resourceType: string,
  sideEffect: CheckpointMetadata['sideEffect'] = 'none',
): CheckpointMetadata {
  return {
    id,
    version: '1.0.0',
    resourceType,
    risk: sideEffect === 'none' ? 'low' : 'medium',
    sideEffect,
    credentialProfile: 'collaboration',
    localPreconditions: sideEffect === 'none' ? ['schema-valid'] : ['schema-valid', 'non-empty-content'],
  };
}

function requireData<T>(response: { data?: T; error?: unknown }): T {
  if (response.data === undefined) throw new Error('Forgejo returned no response data');
  return response.data;
}

/**
 * A single-record read answers BOTH the plain data (AI face) and a `detail`
 * card the Panel renders (panel-ce#193 #13: Get on a row opened to nothing —
 * the object had no display shape). Same words, one envelope.
 */
function withDetail<T extends Record<string, unknown>>(data: T, title: string, fields: Array<{ key: string; label: string; format?: string; copyable?: boolean }>): T & { detail: Record<string, unknown> } {
  return { ...data, detail: { title, data, fields } };
}

function repositorySummary(repo: {
  id?: number;
  name?: string;
  full_name?: string;
  description?: string;
  private?: boolean;
  fork?: boolean;
  default_branch?: string;
  html_url?: string;
  updated_at?: string;
}): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    fork: repo.fork,
    defaultBranch: repo.default_branch,
    url: repo.html_url,
    updatedAt: repo.updated_at,
  };
}

/**
 * The Action's own description travels at the ROOT of its inputSchema too
 * (Widget Design Conventions §5): the schema bytes are what the Platform
 * admits and what Exposure projects to an AI host (exposure#48), so this is
 * the one place the author's words reach a caller that sees only the schema.
 */
/**
 * Human labels for every governed input field (panel-ce#193 #4, owner
 * 2026-09-06: "label 名称,不要用简写"). `title` is a JSON Schema annotation the
 * Platform admits (platform-ce#306) and the Panel renders as the field label
 * (`title ?? key`); it travels in the admitted record to the AI host too. A
 * field may declare its own `title`; this map fills the ones that do not, and
 * the schema-descriptions tripwire refuses a field with neither.
 */
export const FIELD_TITLES: Readonly<Record<string, string>> = {
  owner: 'Owner', repo: 'Repository', owners: 'Owners (organizations or users)', index: 'Number', page: 'Page', limit: 'Items per page',
  reason: 'Reason', title: 'Title', body: 'Body', head: 'Source branch', base: 'Target branch', event: 'Review verdict',
  expectedHeadRevision: 'Expected head revision', strategy: 'Merge strategy', requiredStatusChecks: 'Required status checks',
  message: 'Commit message', state: 'State', expectedUpdatedAt: 'Expected last update', sourceBranch: 'Source branch',
  newBranch: 'New branch', expectedSourceRevision: 'Expected source revision', branch: 'Branch',
  expectedBranchRevision: 'Expected branch revision', signoff: 'Sign-off', files: 'Files', operation: 'Operation', path: 'Path',
  content: 'Content', expectedFileRevision: 'Expected file revision', labelIds: 'Label ids', baseUrl: 'Forgejo URL',
  collaborationToken: 'Collaboration token',
};

/** Apply FIELD_TITLES where a property (nested object members and array items included) declares no `title`. */
export function withFieldTitles(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props) return schema;
  const next: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(props)) {
    let prop: Record<string, unknown> = typeof v['title'] === 'string' ? v : { ...(FIELD_TITLES[k] ? { title: FIELD_TITLES[k] } : {}), ...v };
    if (prop['type'] === 'object') prop = withFieldTitles(prop);
    const items = prop['items'] as Record<string, unknown> | undefined;
    if (items && items['type'] === 'object') prop = { ...prop, items: withFieldTitles(items) };
    next[k] = prop;
  }
  return { ...schema, properties: next };
}

function describedCatalog(actions: ActionDefinition[]): ActionDefinition[] {
  return actions.map((a) => {
    const schema = a.inputSchema as Record<string, unknown> | undefined;
    if (!schema) return a;
    const titled = withFieldTitles(schema);
    return { ...a, inputSchema: { ...(typeof titled['title'] === 'string' ? {} : { title: a.label }), ...(typeof titled['description'] === 'string' ? {} : { description: a.description }), ...titled } };
  });
}

export function buildActionCatalog(): ActionDefinition[] {
  return describedCatalog(rawCatalog());
}

function rawCatalog(): ActionDefinition[] {
  return [
    {
      name: 'getRepository',
      version: '1.0.0',
      label: 'Get Repository',
      description: 'Read the bounded public metadata of one Forgejo repository.',
      capability: 'forgejo.inspect',
      credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.inspect.repository.get', 'forgejo.repository'),
      inputSchema: objectSchema(OWNER_REPO_PROPERTIES, ['owner', 'repo']),
      async execute(input, { client, signal }) {
        const owner = text(input, 'owner');
        const repo = text(input, 'repo');
        const response = await client.GET('/repos/{owner}/{repo}', {
          params: { path: { owner, repo } },
          ...(signal ? { signal } : {}),
        });
        const summary = repositorySummary(requireData(response));
        return withDetail(summary, `${summary['fullName'] ?? `${owner}/${repo}`}`, [
          { key: 'fullName', label: 'Repository', format: 'code', copyable: true },
          { key: 'description', label: 'Description' },
          { key: 'private', label: 'Private', format: 'boolean' },
          { key: 'fork', label: 'Fork', format: 'boolean' },
          { key: 'defaultBranch', label: 'Default branch', format: 'code' },
          { key: 'url', label: 'URL', copyable: true },
          { key: 'updatedAt', label: 'Updated' },
        ]);
      },
    },
    {
      name: 'listBranches',
      version: '1.0.0',
      label: 'List Branches',
      description: 'List repository branches with their revision and protection state.',
      capability: 'forgejo.inspect',
      credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.inspect.branch.list', 'forgejo.branch'),
      inputSchema: objectSchema(
        {
          ...OWNER_REPO_PROPERTIES,
          page: { type: 'integer', minimum: 1, default: 1, description: 'Page number, starting at 1.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30, description: 'Items per page (1–100).' },
        },
        ['owner', 'repo'],
      ),
      async execute(input, { client, signal }) {
        const owner = text(input, 'owner');
        const repo = text(input, 'repo');
        const page = typeof input.page === 'number' ? input.page : 1;
        const limit = typeof input.limit === 'number' ? input.limit : 30;
        const response = await client.GET('/repos/{owner}/{repo}/branches', {
          params: { path: { owner, repo }, query: { page, limit } },
          ...(signal ? { signal } : {}),
        });
        const branches = requireData(response);
        return {
          owner,
          repo,
          page,
          limit,
          branches: branches.map((branch) => ({
            name: branch.name,
            revision: branch.commit?.id,
            protected: branch.protected,
          })),
        };
      },
    },
    {
      name: 'getBranch',
      version: '1.0.0',
      label: 'Get Branch',
      description: 'Read one branch, including the effective protection state.',
      capability: 'forgejo.inspect',
      credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.inspect.branch.get', 'forgejo.branch'),
      inputSchema: objectSchema(
        { ...OWNER_REPO_PROPERTIES, branch: { type: 'string', minLength: 1, maxLength: 255, description: 'Branch name (e.g. "main").' } },
        ['owner', 'repo', 'branch'],
      ),
      async execute(input, { client, signal }) {
        const owner = text(input, 'owner');
        const repo = text(input, 'repo');
        const branch = text(input, 'branch');
        const response = await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch } },
          ...(signal ? { signal } : {}),
        });
        const data = requireData(response);
        return { owner, repo, name: data.name, revision: data.commit?.id, protected: data.protected };
      },
    },
    {
      name: 'getIssue',
      version: '1.0.0',
      label: 'Get Issue',
      description: 'Read one Forgejo issue without exposing credential-bearing transport details.',
      capability: 'forgejo.inspect',
      credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.inspect.issue.get', 'forgejo.issue'),
      inputSchema: objectSchema(
        { ...OWNER_REPO_PROPERTIES, index: { type: 'integer', minimum: 1, description: 'The issue number shown in Forgejo (the N in /issues/N).' } },
        ['owner', 'repo', 'index'],
      ),
      async execute(input, { client, signal }) {
        const owner = text(input, 'owner');
        const repo = text(input, 'repo');
        const index = integer(input, 'index');
        const response = await client.GET('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } },
          ...(signal ? { signal } : {}),
        });
        const issue = requireData(response);
        return withDetail({
          owner,
          repo,
          index: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          url: issue.html_url,
          labels: issue.labels?.map((label) => label.name),
          milestone: issue.milestone?.title,
          assignees: issue.assignees?.map((assignee) => assignee.login),
          updatedAt: issue.updated_at,
        }, `#${String(issue.number)} ${issue.title ?? ''}`, [
          { key: 'index', label: 'Number', format: 'code' },
          { key: 'title', label: 'Title' },
          { key: 'state', label: 'State', format: 'status' },
          { key: 'labels', label: 'Labels' },
          { key: 'milestone', label: 'Milestone' },
          { key: 'body', label: 'Body', format: 'pre' },
          { key: 'url', label: 'URL', copyable: true },
        ]);
      },
    },
    {
      name: 'getPullRequest',
      version: '1.0.0',
      label: 'Get Pull Request',
      description: 'Read one pull request and its current head/base revisions.',
      capability: 'forgejo.inspect',
      credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.inspect.pull-request.get', 'forgejo.pull-request'),
      inputSchema: objectSchema(
        { ...OWNER_REPO_PROPERTIES, index: { type: 'integer', minimum: 1, description: 'The pull request number shown in Forgejo (the N in /pulls/N).' } },
        ['owner', 'repo', 'index'],
      ),
      async execute(input, { client, signal }) {
        const owner = text(input, 'owner');
        const repo = text(input, 'repo');
        const index = integer(input, 'index');
        const response = await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } },
          ...(signal ? { signal } : {}),
        });
        const pull = requireData(response);
        return withDetail({
          owner,
          repo,
          index: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          url: pull.html_url,
          draft: pull.draft,
          mergeable: pull.mergeable,
          merged: pull.merged,
          author: pull.user?.login,
          head: { branch: pull.head?.ref, revision: pull.head?.sha },
          base: { branch: pull.base?.ref, revision: pull.base?.sha },
          updatedAt: pull.updated_at,
        }, `#${String(pull.number)} ${pull.title ?? ''}`, [
          { key: 'index', label: 'Number', format: 'code' },
          { key: 'title', label: 'Title' },
          { key: 'state', label: 'State', format: 'status' },
          { key: 'author', label: 'Author', format: 'code' },
          { key: 'draft', label: 'Draft', format: 'boolean' },
          { key: 'mergeable', label: 'Mergeable', format: 'boolean' },
          { key: 'merged', label: 'Merged', format: 'boolean' },
          { key: 'head.branch', label: 'Source branch', format: 'code' },
          { key: 'base.branch', label: 'Target branch', format: 'code' },
          { key: 'body', label: 'Body', format: 'pre' },
          { key: 'url', label: 'URL', copyable: true },
        ]);
      },
    },
    {
      name: 'commentIssue',
      version: '1.0.0',
      label: 'Comment on Issue',
      description: 'Add a bounded non-empty comment to one issue or pull request conversation.',
      capability: 'forgejo.collaborate',
      credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue.comment.create', 'forgejo.issue-comment', 'write'),
      inputSchema: objectSchema(
        {
          ...OWNER_REPO_PROPERTIES,
          index: { type: 'integer', minimum: 1, description: 'The issue or pull request number shown in Forgejo (the N in /issues/N or /pulls/N).' },
          body: { type: 'string', minLength: 1, maxLength: 65_536, description: 'The comment text (Markdown), non-empty.' },
          reason: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Why this change is being made, in one or two sentences; recorded with the audit entry, never sent to Forgejo.' },
        },
        ['owner', 'repo', 'index', 'body', 'reason'],
      ),
      async execute(input, { client, signal }) {
        const owner = text(input, 'owner');
        const repo = text(input, 'repo');
        const index = integer(input, 'index');
        const body = text(input, 'body');
        const response = await client.POST('/repos/{owner}/{repo}/issues/{index}/comments', {
          params: { path: { owner, repo, index } },
          body: { body },
          ...(signal ? { signal } : {}),
        });
        const comment = requireData(response);
        return { owner, repo, index, commentId: comment.id, url: comment.html_url, createdAt: comment.created_at };
      },
    },
    ...buildInspectionActions(),
    ...buildCollaborationActions(),
    ...buildContentActions(),
    ...buildGovernanceActions(),
    ...buildAdministrationActions(),
  ];
}

export type ActionClient = ForgejoOpenApiClient;
