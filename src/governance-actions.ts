import type { ForgejoOpenApiClient } from '@xtrape/forgejo-api';
import { assertExpectedRevision, assertWritableBranch } from './policy.js';
import type { ActionDefinition, CheckpointMetadata, SideEffect } from './types.js';

const OWNER_REPO = {
  owner: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository owner — the user or organization name as it appears in the repository URL (e.g. "m1ops" in m1ops/m1-demo).' },
  repo: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository name as it appears in the URL (e.g. "m1-demo" in m1ops/m1-demo), without the owner.' },
} as const;
const REASON = { reason: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Why this change is being made, in one or two sentences; recorded with the audit entry, never sent to Forgejo.' } } as const;
const PROTECTION_FIELDS = {
  requiredApprovals: { type: 'integer', minimum: 0, maximum: 100 },
  requireSignedCommits: { type: 'boolean' },
  blockOnRejectedReviews: { type: 'boolean' },
  blockOnOutdatedBranch: { type: 'boolean' },
  dismissStaleApprovals: { type: 'boolean' },
  enableStatusCheck: { type: 'boolean' },
  statusCheckContexts: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 100, uniqueItems: true },
  enablePush: { type: 'boolean' },
  applyToAdmins: { type: 'boolean' },
} as const;

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]; if (typeof value !== 'string') throw new Error(`${key} must be a string`); return value;
}
function int(input: Record<string, unknown>, key: string): number {
  const value = input[key]; if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`); return value;
}
function data<T>(response: { data?: T }): T {
  if (response.data === undefined) throw new Error('Forgejo returned no response data'); return response.data;
}
function checkpoint(id: string, resourceType: string, sideEffect: SideEffect, preconditions: string[]): CheckpointMetadata {
  return { id, version: '1.0.0', resourceType, risk: sideEffect === 'destructive' ? 'critical' : 'high', sideEffect,
    credentialProfile: 'administration', localPreconditions: ['schema-valid', 'human-reason', ...preconditions] };
}
function protectionBody(input: Record<string, unknown>) {
  return {
    ...(typeof input.requiredApprovals === 'number' ? { required_approvals: input.requiredApprovals } : {}),
    ...(typeof input.requireSignedCommits === 'boolean' ? { require_signed_commits: input.requireSignedCommits } : {}),
    ...(typeof input.blockOnRejectedReviews === 'boolean' ? { block_on_rejected_reviews: input.blockOnRejectedReviews } : {}),
    ...(typeof input.blockOnOutdatedBranch === 'boolean' ? { block_on_outdated_branch: input.blockOnOutdatedBranch } : {}),
    ...(typeof input.dismissStaleApprovals === 'boolean' ? { dismiss_stale_approvals: input.dismissStaleApprovals } : {}),
    ...(typeof input.enableStatusCheck === 'boolean' ? { enable_status_check: input.enableStatusCheck } : {}),
    ...(Array.isArray(input.statusCheckContexts) ? { status_check_contexts: input.statusCheckContexts as string[] } : {}),
    ...(typeof input.enablePush === 'boolean' ? { enable_push: input.enablePush } : {}),
    ...(typeof input.applyToAdmins === 'boolean' ? { apply_to_admins: input.applyToAdmins } : {}),
  };
}
function publicProtection(protection: {
  rule_name?: string; branch_name?: string; required_approvals?: number; require_signed_commits?: boolean;
  block_on_rejected_reviews?: boolean; block_on_outdated_branch?: boolean; dismiss_stale_approvals?: boolean;
  enable_status_check?: boolean; status_check_contexts?: string[]; enable_push?: boolean; apply_to_admins?: boolean;
  created_at?: string; updated_at?: string;
}) {
  return { name: protection.rule_name ?? protection.branch_name, requiredApprovals: protection.required_approvals,
    requireSignedCommits: protection.require_signed_commits, blockOnRejectedReviews: protection.block_on_rejected_reviews,
    blockOnOutdatedBranch: protection.block_on_outdated_branch, dismissStaleApprovals: protection.dismiss_stale_approvals,
    enableStatusCheck: protection.enable_status_check, statusCheckContexts: protection.status_check_contexts,
    enablePush: protection.enable_push, applyToAdmins: protection.apply_to_admins,
    createdAt: protection.created_at, updatedAt: protection.updated_at };
}
async function expectedPull(client: ForgejoOpenApiClient, owner: string, repo: string, index: number, expectedHead: string, signal?: AbortSignal) {
  const pull = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
    params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
  }));
  assertExpectedRevision(pull.head?.sha, expectedHead);
  if (pull.state !== 'open' || pull.merged === true) throw new Error('pull request is not open and unmerged');
  return pull;
}

export function buildGovernanceActions(): ActionDefinition[] {
  return [
    {
      name: 'createLabel', version: '1.0.0', label: 'Create Repository Label',
      description: 'Create one repository label with an explicit color and bounded metadata.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.label.create', 'forgejo.label', 'write', ['explicit-label-color']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, name: { type: 'string', minLength: 1, maxLength: 255 },
        color: { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' }, description: { type: 'string', maxLength: 4_096 },
        exclusive: { type: 'boolean', default: false }, archived: { type: 'boolean', default: false },
      }, ['owner', 'repo', 'name', 'color', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const label = data(await client.POST('/repos/{owner}/{repo}/labels', {
          params: { path: { owner, repo } }, body: { name: string(input, 'name'), color: string(input, 'color'),
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            exclusive: input.exclusive === true, is_archived: input.archived === true }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: label.id, name: label.name, color: label.color, description: label.description,
          exclusive: label.exclusive, archived: label.is_archived };
      },
    },
    {
      name: 'updateLabel', version: '1.0.0', label: 'Update Repository Label',
      description: 'Update one label only after its ID, name and color match the reviewed state.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.label.update', 'forgejo.label', 'write', ['expected-label-identity']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, id: { type: 'integer', minimum: 1 },
        expectedName: { type: 'string', minLength: 1, maxLength: 255 }, expectedColor: { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' },
        name: { type: 'string', minLength: 1, maxLength: 255 }, color: { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' },
        description: { type: 'string', maxLength: 4_096 }, exclusive: { type: 'boolean' }, archived: { type: 'boolean' },
      }, ['owner', 'repo', 'id', 'expectedName', 'expectedColor', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const current = data(await client.GET('/repos/{owner}/{repo}/labels/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        if (current.name !== string(input, 'expectedName') || current.color?.replace(/^#/, '').toLowerCase() !== string(input, 'expectedColor').replace(/^#/, '').toLowerCase()) {
          throw new Error('label identity does not match the reviewed state');
        }
        const body = { ...(typeof input.name === 'string' ? { name: input.name } : {}),
          ...(typeof input.color === 'string' ? { color: input.color } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(typeof input.exclusive === 'boolean' ? { exclusive: input.exclusive } : {}),
          ...(typeof input.archived === 'boolean' ? { is_archived: input.archived } : {}) };
        if (Object.keys(body).length === 0) throw new Error('at least one label field is required');
        const label = data(await client.PATCH('/repos/{owner}/{repo}/labels/{id}', {
          params: { path: { owner, repo, id } }, body, idempotent: true, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: label.id, name: label.name, color: label.color, description: label.description,
          exclusive: label.exclusive, archived: label.is_archived };
      },
    },
    {
      name: 'createMilestone', version: '1.0.0', label: 'Create Milestone',
      description: 'Create one repository milestone with an explicit initial state.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.milestone.create', 'forgejo.milestone', 'write', ['explicit-milestone-state']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, title: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: 'string', maxLength: 16_384 }, dueOn: { type: 'string', format: 'date-time' },
        state: { enum: ['open', 'closed'] },
      }, ['owner', 'repo', 'title', 'state', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const milestone = data(await client.POST('/repos/{owner}/{repo}/milestones', { params: { path: { owner, repo } },
          body: { title: string(input, 'title'), state: string(input, 'state') as 'open' | 'closed',
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(typeof input.dueOn === 'string' ? { due_on: input.dueOn } : {}) }, ...(signal ? { signal } : {}) }));
        return { owner, repo, id: milestone.id, title: milestone.title, description: milestone.description,
          state: milestone.state, dueOn: milestone.due_on, updatedAt: milestone.updated_at };
      },
    },
    {
      name: 'updateMilestone', version: '1.0.0', label: 'Update Milestone',
      description: 'Update one milestone after an updated-at concurrency check.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.milestone.update', 'forgejo.milestone', 'write', ['expected-updated-at']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, id: { type: 'integer', minimum: 1 },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 }, title: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: 'string', maxLength: 16_384 }, dueOn: { type: 'string', format: 'date-time' }, state: { enum: ['open', 'closed'] },
      }, ['owner', 'repo', 'id', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const current = data(await client.GET('/repos/{owner}/{repo}/milestones/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, string(input, 'expectedUpdatedAt'));
        const body = { ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(typeof input.dueOn === 'string' ? { due_on: input.dueOn } : {}),
          ...(typeof input.state === 'string' ? { state: input.state } : {}) };
        if (Object.keys(body).length === 0) throw new Error('at least one milestone field is required');
        const milestone = data(await client.PATCH('/repos/{owner}/{repo}/milestones/{id}', {
          params: { path: { owner, repo, id } }, body, idempotent: true, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: milestone.id, title: milestone.title, description: milestone.description,
          state: milestone.state, dueOn: milestone.due_on, updatedAt: milestone.updated_at };
      },
    },
    {
      name: 'mergePullRequest', version: '1.0.0', label: 'Merge Pull Request',
      description: 'Merge one open pull request at an exact reviewed head; branch deletion is deliberately separate.',
      capability: 'forgejo.governance', credentialProfile: 'collaboration',
      checkpoint: {
        ...checkpoint('forgejo.governance.pull-request.merge', 'forgejo.pull-request', 'write', ['expected-head-revision', 'open-unmerged']),
        credentialProfile: 'collaboration',
      },
      inputSchema: schema({ ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        expectedHeadRevision: { type: 'string', minLength: 1, maxLength: 255 },
        method: { enum: ['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'] },
        title: { type: 'string', maxLength: 255 }, message: { type: 'string', maxLength: 262_144 },
      }, ['owner', 'repo', 'index', 'expectedHeadRevision', 'method', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const expectedHead = string(input, 'expectedHeadRevision'); const method = string(input, 'method') as 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'fast-forward-only';
        await expectedPull(client, owner, repo, index, expectedHead, signal);
        await client.POST('/repos/{owner}/{repo}/pulls/{index}/merge', {
          params: { path: { owner, repo, index } }, body: { Do: method, head_commit_id: expectedHead,
            force_merge: false, delete_branch_after_merge: false,
            ...(typeof input.title === 'string' ? { MergeTitleField: input.title } : {}),
            ...(typeof input.message === 'string' ? { MergeMessageField: input.message } : {}) },
          ...(signal ? { signal } : {}),
        });
        return { owner, repo, index, mergedHeadRevision: expectedHead, method, merged: true };
      },
    },
    {
      name: 'createRelease', version: '1.0.0', label: 'Create Release',
      description: 'Create a release/tag from a branch pinned to its exact expected revision.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.release.create', 'forgejo.release', 'write', ['expected-target-revision']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, tag: { type: 'string', minLength: 1, maxLength: 255 },
        targetBranch: { type: 'string', minLength: 1, maxLength: 255 }, expectedTargetRevision: { type: 'string', minLength: 1, maxLength: 255 },
        name: { type: 'string', maxLength: 255 }, body: { type: 'string', maxLength: 524_288 },
        draft: { type: 'boolean', default: false }, prerelease: { type: 'boolean', default: false },
      }, ['owner', 'repo', 'tag', 'targetBranch', 'expectedTargetRevision', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const tag = string(input, 'tag');
        const targetBranch = string(input, 'targetBranch'); const expectedTarget = string(input, 'expectedTargetRevision');
        const branch = data(await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: targetBranch } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(branch.commit?.id, expectedTarget);
        const release = data(await client.POST('/repos/{owner}/{repo}/releases', {
          params: { path: { owner, repo } }, body: { tag_name: tag, target_commitish: expectedTarget,
            draft: input.draft === true, prerelease: input.prerelease === true,
            ...(typeof input.name === 'string' ? { name: input.name } : {}),
            ...(typeof input.body === 'string' ? { body: input.body } : {}) },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, id: release.id, tag: release.tag_name, targetRevision: expectedTarget,
          name: release.name, draft: release.draft, prerelease: release.prerelease, url: release.html_url, createdAt: release.created_at };
      },
    },
    {
      name: 'getBranchProtection', version: '1.0.0', label: 'Get Branch Protection',
      description: 'Read one branch-protection rule for review before governance changes.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: { ...checkpoint('forgejo.governance.branch-protection.get', 'forgejo.branch-protection', 'none', []), risk: 'medium', localPreconditions: ['schema-valid'] },
      inputSchema: schema({ ...OWNER_REPO, name: { type: 'string', minLength: 1, maxLength: 255 } }, ['owner', 'repo', 'name']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const name = string(input, 'name');
        const protection = data(await client.GET('/repos/{owner}/{repo}/branch_protections/{name}', {
          params: { path: { owner, repo, name } }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, protection: publicProtection(protection) };
      },
    },
    {
      name: 'createBranchProtection', version: '1.0.0', label: 'Create Branch Protection',
      description: 'Create a bounded branch-protection rule; it cannot configure arbitrary whitelist identities.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.branch-protection.create', 'forgejo.branch-protection', 'write', ['new-rule']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, name: { type: 'string', minLength: 1, maxLength: 255 }, ...PROTECTION_FIELDS }, ['owner', 'repo', 'name', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const name = string(input, 'name');
        const protection = data(await client.POST('/repos/{owner}/{repo}/branch_protections', {
          params: { path: { owner, repo } }, body: { rule_name: name, ...protectionBody(input) }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, protection: publicProtection(protection) };
      },
    },
    {
      name: 'updateBranchProtection', version: '1.0.0', label: 'Update Branch Protection',
      description: 'Update bounded protection settings after checking the rule updated-at value.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.branch-protection.update', 'forgejo.branch-protection', 'write', ['expected-updated-at']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, name: { type: 'string', minLength: 1, maxLength: 255 },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 }, ...PROTECTION_FIELDS }, ['owner', 'repo', 'name', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const name = string(input, 'name');
        const current = data(await client.GET('/repos/{owner}/{repo}/branch_protections/{name}', {
          params: { path: { owner, repo, name } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, string(input, 'expectedUpdatedAt'));
        const body = protectionBody(input);
        if (Object.keys(body).length === 0) throw new Error('at least one branch-protection setting is required');
        const protection = data(await client.PATCH('/repos/{owner}/{repo}/branch_protections/{name}', {
          params: { path: { owner, repo, name } }, body, idempotent: true, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, protection: publicProtection(protection) };
      },
    },
    {
      name: 'deleteBranch', version: '1.0.0', label: 'Delete Branch',
      description: 'Delete one unprotected branch at an exact expected revision.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.branch.delete', 'forgejo.branch', 'destructive', ['expected-revision', 'unprotected-branch']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, branch: { type: 'string', minLength: 1, maxLength: 255 },
        expectedRevision: { type: 'string', minLength: 1, maxLength: 255 }, confirmBranch: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['owner', 'repo', 'branch', 'expectedRevision', 'confirmBranch', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const branchName = string(input, 'branch');
        if (string(input, 'confirmBranch') !== branchName) throw new Error('branch confirmation does not match');
        const branch = data(await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: branchName } }, ...(signal ? { signal } : {}),
        }));
        assertWritableBranch(branch.protected); assertExpectedRevision(branch.commit?.id, string(input, 'expectedRevision'));
        const repository = data(await client.GET('/repos/{owner}/{repo}', {
          params: { path: { owner, repo } }, ...(signal ? { signal } : {}),
        }));
        if (repository.default_branch === branchName) throw new Error('default branch deletion is denied by Widget-local safety policy');
        await client.DELETE('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: branchName } }, ...(signal ? { signal } : {}),
        });
        return { owner, repo, branch: branchName, deleted: true };
      },
    },
    {
      name: 'deleteLabel', version: '1.0.0', label: 'Delete Repository Label',
      description: 'Delete one label after matching its ID, name and explicit confirmation.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.label.delete', 'forgejo.label', 'destructive', ['expected-label-name', 'label-confirmation']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, id: { type: 'integer', minimum: 1 },
        expectedName: { type: 'string', minLength: 1, maxLength: 255 }, confirmName: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['owner', 'repo', 'id', 'expectedName', 'confirmName', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const expectedName = string(input, 'expectedName');
        if (string(input, 'confirmName') !== expectedName) throw new Error('label confirmation does not match');
        const label = data(await client.GET('/repos/{owner}/{repo}/labels/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(label.name, expectedName);
        await client.DELETE('/repos/{owner}/{repo}/labels/{id}', { params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}) });
        return { owner, repo, id, name: expectedName, deleted: true };
      },
    },
    {
      name: 'deleteMilestone', version: '1.0.0', label: 'Delete Milestone',
      description: 'Delete one milestone after matching its ID, title, updated-at value and confirmation.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.milestone.delete', 'forgejo.milestone', 'destructive', ['expected-updated-at', 'milestone-confirmation']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, id: { type: 'integer', minimum: 1 },
        expectedTitle: { type: 'string', minLength: 1, maxLength: 255 }, expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 },
        confirmTitle: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['owner', 'repo', 'id', 'expectedTitle', 'expectedUpdatedAt', 'confirmTitle', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const expectedTitle = string(input, 'expectedTitle');
        if (string(input, 'confirmTitle') !== expectedTitle) throw new Error('milestone confirmation does not match');
        const milestone = data(await client.GET('/repos/{owner}/{repo}/milestones/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(milestone.title, expectedTitle);
        assertExpectedRevision(milestone.updated_at, string(input, 'expectedUpdatedAt'));
        await client.DELETE('/repos/{owner}/{repo}/milestones/{id}', { params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}) });
        return { owner, repo, id, title: expectedTitle, deleted: true };
      },
    },
    {
      name: 'deleteRelease', version: '1.0.0', label: 'Delete Release',
      description: 'Delete one release record after matching its immutable ID and tag; the tag itself is retained.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.release.delete', 'forgejo.release', 'destructive', ['expected-release-tag']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, id: { type: 'integer', minimum: 1 }, expectedTag: { type: 'string', minLength: 1, maxLength: 255 },
        confirmTag: { type: 'string', minLength: 1, maxLength: 255 } }, ['owner', 'repo', 'id', 'expectedTag', 'confirmTag', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const id = int(input, 'id');
        const expectedTag = string(input, 'expectedTag'); if (string(input, 'confirmTag') !== expectedTag) throw new Error('tag confirmation does not match');
        const release = data(await client.GET('/repos/{owner}/{repo}/releases/{id}', {
          params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(release.tag_name, expectedTag);
        await client.DELETE('/repos/{owner}/{repo}/releases/{id}', { params: { path: { owner, repo, id } }, ...(signal ? { signal } : {}) });
        return { owner, repo, id, tag: expectedTag, releaseDeleted: true, tagDeleted: false };
      },
    },
    {
      name: 'deleteRepository', version: '1.0.0', label: 'Delete Repository',
      description: 'Permanently delete one repository after matching its numeric ID and full-name confirmation.',
      capability: 'forgejo.governance', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.governance.repository.delete', 'forgejo.repository', 'destructive', ['expected-repository-id', 'full-name-confirmation']),
      inputSchema: schema({ ...OWNER_REPO, ...REASON, expectedRepositoryId: { type: 'integer', minimum: 1 },
        confirmFullName: { type: 'string', minLength: 3, maxLength: 511 } }, ['owner', 'repo', 'expectedRepositoryId', 'confirmFullName', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const expectedId = int(input, 'expectedRepositoryId');
        const fullName = `${owner}/${repo}`; if (string(input, 'confirmFullName') !== fullName) throw new Error('repository confirmation does not match');
        const repository = data(await client.GET('/repos/{owner}/{repo}', {
          params: { path: { owner, repo } }, ...(signal ? { signal } : {}),
        }));
        if (repository.id !== expectedId || repository.full_name !== fullName) throw new Error('repository identity does not match the expected target');
        await client.DELETE('/repos/{owner}/{repo}', { params: { path: { owner, repo } }, ...(signal ? { signal } : {}) });
        return { owner, repo, repositoryId: expectedId, deleted: true };
      },
    },
  ];
}
