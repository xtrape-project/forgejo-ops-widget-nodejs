import { mapChangeFilesRequestBody } from '@xtrape/forgejo-api';
import { assertExpectedRevision, assertWritableBranch } from './policy.js';
import type { ActionDefinition, CheckpointMetadata } from './types.js';

const OWNER_REPO = {
  owner: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository owner — the user or organization name as it appears in the repository URL (e.g. "m1ops" in m1ops/m1-demo).' },
  repo: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository name as it appears in the URL (e.g. "m1-demo" in m1ops/m1-demo), without the owner.' },
} as const;
const REASON = { reason: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Why this change is being made, in one or two sentences; recorded with the audit entry, never sent to Forgejo.' } } as const;

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]; if (typeof value !== 'string') throw new Error(`${key} must be a string`); return value;
}
function checkpoint(id: string, resourceType: string, preconditions: string[]): CheckpointMetadata {
  return { id, version: '1.0.0', resourceType, risk: 'medium', sideEffect: 'write', credentialProfile: 'collaboration',
    localPreconditions: ['schema-valid', 'human-reason', 'protected-branch-deny', 'expected-revision', ...preconditions] };
}
function data<T>(response: { data?: T }): T {
  if (response.data === undefined) throw new Error('Forgejo returned no response data'); return response.data;
}

export function buildContentActions(): ActionDefinition[] {
  return [
    {
      name: 'createBranch', version: '1.0.0', label: 'Create Branch',
      description: 'Create a branch from an existing branch pinned to its expected revision.',
      capability: 'forgejo.content', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.content.branch.create', 'forgejo.branch', ['source-branch-exists']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, sourceBranch: { type: 'string', minLength: 1, maxLength: 255, description: 'Existing branch to branch from (e.g. "main").' },
        newBranch: { type: 'string', minLength: 1, maxLength: 255, description: 'Name of the branch to create.' }, expectedSourceRevision: { type: 'string', minLength: 1, maxLength: 255, description: 'The source branch head SHA you observed; refused if it has moved.' },
      }, ['owner', 'repo', 'sourceBranch', 'newBranch', 'expectedSourceRevision', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const sourceBranch = string(input, 'sourceBranch'); const newBranch = string(input, 'newBranch');
        const expectedSourceRevision = string(input, 'expectedSourceRevision');
        const source = data(await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: sourceBranch } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(source.commit?.id, expectedSourceRevision);
        const branch = data(await client.POST('/repos/{owner}/{repo}/branches', {
          params: { path: { owner, repo } }, body: { new_branch_name: newBranch, old_ref_name: expectedSourceRevision },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, name: branch.name, revision: branch.commit?.id, protected: branch.protected };
      },
    },
    {
      name: 'createFile', version: '1.0.0', label: 'Create File',
      description: 'Create one bounded UTF-8 file on an unprotected branch pinned to its expected revision.',
      capability: 'forgejo.content', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.content.file.create', 'forgejo.file', ['file-absent', 'content-size-limit']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, branch: { type: 'string', minLength: 1, maxLength: 255 },
        expectedBranchRevision: { type: 'string', minLength: 1, maxLength: 255 },
        path: { type: 'string', minLength: 1, maxLength: 4_096 }, content: { type: 'string', maxLength: 1_048_576 },
        message: { type: 'string', minLength: 1, maxLength: 4_096 }, signoff: { type: 'boolean', default: false },
      }, ['owner', 'repo', 'branch', 'expectedBranchRevision', 'path', 'content', 'message', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const branchName = string(input, 'branch');
        const expectedBranchRevision = string(input, 'expectedBranchRevision'); const path = string(input, 'path');
        const content = string(input, 'content'); const message = string(input, 'message');
        const branch = data(await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: branchName } }, ...(signal ? { signal } : {}),
        }));
        assertWritableBranch(branch.protected); assertExpectedRevision(branch.commit?.id, expectedBranchRevision);
        const created = data(await client.POST('/repos/{owner}/{repo}/contents/{filepath}', {
          params: { path: { owner, repo, filepath: path } },
          body: { branch: branchName, content: Buffer.from(content, 'utf8').toString('base64'), message, signoff: input.signoff === true },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, branch: branchName, path: created.content?.path, fileRevision: created.content?.sha,
          commitRevision: created.commit?.sha, commitUrl: created.commit?.html_url };
      },
    },
    {
      name: 'updateFile', version: '1.0.0', label: 'Update File',
      description: 'Replace one bounded UTF-8 file using both expected branch and file revisions.',
      capability: 'forgejo.content', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.content.file.update', 'forgejo.file', ['expected-file-revision', 'content-size-limit']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, branch: { type: 'string', minLength: 1, maxLength: 255 },
        expectedBranchRevision: { type: 'string', minLength: 1, maxLength: 255 },
        path: { type: 'string', minLength: 1, maxLength: 4_096 }, expectedFileRevision: { type: 'string', minLength: 1, maxLength: 255 },
        content: { type: 'string', maxLength: 1_048_576 }, message: { type: 'string', minLength: 1, maxLength: 4_096 },
        signoff: { type: 'boolean', default: false },
      }, ['owner', 'repo', 'branch', 'expectedBranchRevision', 'path', 'expectedFileRevision', 'content', 'message', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const branchName = string(input, 'branch');
        const expectedBranchRevision = string(input, 'expectedBranchRevision'); const path = string(input, 'path');
        const expectedFileRevision = string(input, 'expectedFileRevision'); const content = string(input, 'content');
        const message = string(input, 'message');
        const branch = data(await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: branchName } }, ...(signal ? { signal } : {}),
        }));
        assertWritableBranch(branch.protected); assertExpectedRevision(branch.commit?.id, expectedBranchRevision);
        const current = data(await client.GET('/repos/{owner}/{repo}/contents/{filepath}', {
          params: { path: { owner, repo, filepath: path }, query: { ref: branchName } }, ...(signal ? { signal } : {}),
        }));
        if (Array.isArray(current)) throw new Error('requested path is a directory');
        assertExpectedRevision(current.sha, expectedFileRevision);
        const updated = data(await client.PUT('/repos/{owner}/{repo}/contents/{filepath}', {
          params: { path: { owner, repo, filepath: path } },
          body: { branch: branchName, sha: expectedFileRevision, content: Buffer.from(content, 'utf8').toString('base64'), message, signoff: input.signoff === true },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, branch: branchName, path: updated.content?.path, fileRevision: updated.content?.sha,
          commitRevision: updated.commit?.sha, commitUrl: updated.commit?.html_url };
      },
    },
    {
      name: 'atomicCommitFiles', version: '1.0.0', label: 'Atomic Commit Files',
      description: 'Atomically create, update or delete up to 100 files on an unprotected branch at an exact expected revision.',
      capability: 'forgejo.content', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.content.files.atomic-commit', 'forgejo.commit', ['expected-file-revisions', 'aggregate-content-limit']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, branch: { type: 'string', minLength: 1, maxLength: 255, description: 'Branch to commit to (must be unprotected).' },
        expectedBranchRevision: { type: 'string', minLength: 1, maxLength: 255, description: 'The branch head SHA you observed; the commit is refused if it has moved.' },
        message: { type: 'string', minLength: 1, maxLength: 4_096, description: 'Commit message.' }, signoff: { type: 'boolean', default: false, description: 'Append a Signed-off-by trailer.' },
        files: { type: 'array', minItems: 1, maxItems: 100, description: 'The file operations applied together in ONE commit.', items: {
          type: 'object', additionalProperties: false,
          properties: {
            operation: { enum: ['create', 'update', 'delete'], description: 'create, update or delete this path.' }, path: { type: 'string', minLength: 1, maxLength: 4_096, description: 'File path inside the repository.' },
            content: { type: 'string', maxLength: 1_048_576, description: 'Full UTF-8 file content for create/update; omit for delete.' }, expectedFileRevision: { type: 'string', minLength: 1, maxLength: 255, description: 'The file blob SHA you observed (update/delete); refused if it changed.' },
          }, required: ['operation', 'path'],
        } },
      }, ['owner', 'repo', 'branch', 'expectedBranchRevision', 'message', 'files', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const branchName = string(input, 'branch');
        const expectedBranchRevision = string(input, 'expectedBranchRevision'); const message = string(input, 'message');
        const files = input.files as Array<{ operation: 'create' | 'update' | 'delete'; path: string; content?: string; expectedFileRevision?: string }>;
        const paths = new Set<string>(); let contentBytes = 0;
        for (const file of files) {
          if (paths.has(file.path)) throw new Error(`duplicate file path: ${file.path}`);
          paths.add(file.path);
          if (file.operation === 'create' && file.expectedFileRevision !== undefined) throw new Error(`create must not declare expectedFileRevision: ${file.path}`);
          if (file.operation !== 'create' && !file.expectedFileRevision) throw new Error(`${file.operation} requires expectedFileRevision: ${file.path}`);
          if (file.operation === 'delete' && file.content !== undefined) throw new Error(`delete must not carry content: ${file.path}`);
          if (file.operation !== 'delete' && file.content === undefined) throw new Error(`${file.operation} requires content: ${file.path}`);
          contentBytes += file.content === undefined ? 0 : Buffer.byteLength(file.content, 'utf8');
        }
        if (contentBytes > 2_097_152) throw new Error('aggregate file content exceeds the 2 MiB limit');
        const branch = data(await client.GET('/repos/{owner}/{repo}/branches/{branch}', {
          params: { path: { owner, repo, branch: branchName } }, ...(signal ? { signal } : {}),
        }));
        assertWritableBranch(branch.protected); assertExpectedRevision(branch.commit?.id, expectedBranchRevision);
        const body = mapChangeFilesRequestBody({ branch: branchName, message, files: files.map((file) => ({
          operation: file.operation, path: file.path,
          ...(file.content !== undefined ? { content: file.content } : {}),
          ...(file.expectedFileRevision ? { sha: file.expectedFileRevision } : {}),
        })) });
        const committed = data(await client.POST('/repos/{owner}/{repo}/contents', {
          params: { path: { owner, repo } }, body: { ...body, signoff: input.signoff === true } as {
            branch?: string; message?: string; signoff?: boolean;
            files: Array<{ operation: 'create' | 'update' | 'delete'; path: string; content?: string; sha?: string }>;
          }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, branch: branchName, operationCount: files.length,
          files: committed.files?.map((file) => ({ path: file.path, revision: file.sha })) ?? [],
          commitRevision: committed.commit?.sha, commitUrl: committed.commit?.html_url };
      },
    },
  ];
}
