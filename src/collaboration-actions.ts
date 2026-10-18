import { toForgejoReviewEvent, type ForgejoOpenApiClient } from '@xtrape/forgejo-api';
import { assertExpectedRevision } from './policy.js';
import { WidgetActionError } from './errors.js';
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
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function int(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function checkpoint(id: string, resourceType: string, preconditions: string[]): CheckpointMetadata {
  return {
    id, version: '1.0.0', resourceType, risk: 'medium', sideEffect: 'write',
    credentialProfile: 'collaboration', localPreconditions: ['schema-valid', 'human-reason', ...preconditions],
  };
}

function data<T>(response: { data?: T }): T {
  if (response.data === undefined) throw new Error('Forgejo returned no response data');
  return response.data;
}

async function pullAtExpectedHead(
  client: ForgejoOpenApiClient, owner: string, repo: string, index: number, expectedHeadRevision: string, signal?: AbortSignal,
) {
  const pull = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
    params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
  }));
  assertExpectedRevision(pull.head?.sha, expectedHeadRevision);
  return pull;
}

type PullReview = { id?: number; state?: string; commit_id?: string; submitted_at?: string; dismissed?: boolean; user?: { login?: string } };

/**
 * Read EVERY review of a pull request, not just the first page. The guarded
 * merge decision reads this to find a blocking `REQUEST_CHANGES`, and a review
 * left on a later page must not be missed — missing an approval only refuses
 * (fail-closed, safe), but missing a request-changes would wrongly ALLOW a
 * merge (fail-open).
 *
 * The end of the list is proven ONLY by an EMPTY page — never by a short one.
 * Forgejo caps a list response at its server-side `MAX_RESPONSE_ITEMS` (50 by
 * default in v15), which is independent of the `limit` we request, so a page
 * shorter than `limit` is NOT proof of exhaustion; a full server page can still
 * be followed by more (#17 review 3067). A hard page cap keeps the read
 * bounded; hitting it means the set could not be exhausted, so the caller
 * REFUSES rather than deciding on a partial review history.
 */
async function listAllPullReviews(
  client: ForgejoOpenApiClient, owner: string, repo: string, index: number, signal?: AbortSignal,
): Promise<PullReview[]> {
  const limit = 100; // requested; the server returns min(limit, MAX_RESPONSE_ITEMS)
  const maxPages = 200; // safety bound (~10k reviews at a 50-item server page)
  const all: PullReview[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}/reviews', {
      params: { path: { owner, repo, index }, query: { page, limit } }, ...(signal ? { signal } : {}),
    }));
    if (batch.length === 0) return all; // an empty page is the only proof of exhaustion
    all.push(...batch);
  }
  throw new WidgetActionError(
    'PRECONDITION_FAILED',
    'the pull request has more reviews than the guarded merge can exhaustively read; refusing rather than deciding a merge on a partial review history',
  );
}

export function buildCollaborationActions(): ActionDefinition[] {
  return [
    {
      name: 'createIssue', version: '1.0.0', label: 'Create Issue',
      description: 'Create one issue with bounded text and optional existing label IDs.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue.create', 'forgejo.issue', ['repository-writable']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON,
        title: { type: 'string', minLength: 1, maxLength: 255, description: 'Issue title.' },
        body: { type: 'string', maxLength: 262_144, default: '', description: 'Issue body (Markdown); empty allowed.' },
        labelIds: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 50, uniqueItems: true, description: 'Numeric label ids to apply (from the repository label list).' },
      }, ['owner', 'repo', 'title', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const title = string(input, 'title'); const body = typeof input.body === 'string' ? input.body : '';
        const labelIds = Array.isArray(input.labelIds) ? input.labelIds as number[] : undefined;
        const issue = data(await client.POST('/repos/{owner}/{repo}/issues', {
          params: { path: { owner, repo } }, body: { title, body, ...(labelIds ? { labels: labelIds } : {}) },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: issue.number, title: issue.title, state: issue.state, url: issue.html_url,
          createdAt: issue.created_at, updatedAt: issue.updated_at };
      },
    },
    {
      name: 'updateIssueMetadata', version: '1.0.0', label: 'Update Issue Metadata',
      description: 'Update only the title and body of one issue after an updated-at concurrency check.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue.metadata.update', 'forgejo.issue', ['expected-updated-at']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: 255 }, body: { type: 'string', maxLength: 262_144 },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 },
      }, ['owner', 'repo', 'index', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const title = typeof input.title === 'string' ? input.title : undefined;
        const body = typeof input.body === 'string' ? input.body : undefined;
        if (title === undefined && body === undefined) throw new Error('at least one of title or body is required');
        const current = data(await client.GET('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, string(input, 'expectedUpdatedAt'));
        const issue = data(await client.PATCH('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, body: {
            ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}),
          }, idempotent: true, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: issue.number, title: issue.title, body: issue.body, state: issue.state,
          url: issue.html_url, updatedAt: issue.updated_at };
      },
    },
    {
      name: 'setIssueState', version: '1.0.0', label: 'Set Issue State',
      description: 'Open or close one issue after an updated-at concurrency check.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue.state.set', 'forgejo.issue', ['expected-updated-at']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1, description: 'The issue number shown in Forgejo (the N in /issues/N).' }, state: { enum: ['open', 'closed'], description: 'Target state: open or closed.' },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64, description: 'The issue\'s updatedAt as last read (ISO-8601); the change is refused if the issue changed since.' },
      }, ['owner', 'repo', 'index', 'state', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const current = data(await client.GET('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, string(input, 'expectedUpdatedAt'));
        const issue = data(await client.PATCH('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, body: { state: string(input, 'state') }, idempotent: true,
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: issue.number, state: issue.state, updatedAt: issue.updated_at, url: issue.html_url };
      },
    },
    {
      name: 'replaceIssueAssignees', version: '1.0.0', label: 'Replace Issue Assignees',
      description: 'Replace the complete assignee set of one issue after an updated-at concurrency check.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue-assignee.replace', 'forgejo.issue', ['expected-updated-at']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        assignees: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 20, uniqueItems: true },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 },
      }, ['owner', 'repo', 'index', 'assignees', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const current = data(await client.GET('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, string(input, 'expectedUpdatedAt'));
        const issue = data(await client.PATCH('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, body: { assignees: input.assignees as string[] }, idempotent: true,
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: issue.number, assignees: issue.assignees?.map((user) => user.login),
          updatedAt: issue.updated_at };
      },
    },
    {
      name: 'setIssueMilestone', version: '1.0.0', label: 'Set Issue Milestone',
      description: 'Set or clear the milestone of one issue after an updated-at concurrency check.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue-milestone.set', 'forgejo.issue', ['expected-updated-at']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        milestoneId: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 },
      }, ['owner', 'repo', 'index', 'milestoneId', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const current = data(await client.GET('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, string(input, 'expectedUpdatedAt'));
        const issue = data(await client.PATCH('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, body: { milestone: input.milestoneId === null ? 0 : input.milestoneId as number }, idempotent: true,
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: issue.number, milestone: issue.milestone
          ? { id: issue.milestone.id, title: issue.milestone.title, state: issue.milestone.state } : null,
        updatedAt: issue.updated_at };
      },
    },
    {
      name: 'replaceIssueLabels', version: '1.0.0', label: 'Replace Issue Labels',
      description: 'Replace the complete label set of one issue after an updated-at concurrency check.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.issue-label.replace', 'forgejo.issue', ['expected-updated-at']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        labels: { type: 'array', items: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', minLength: 1, maxLength: 255 }] }, maxItems: 50, uniqueItems: true },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 },
      }, ['owner', 'repo', 'index', 'labels', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const expectedUpdatedAt = string(input, 'expectedUpdatedAt'); const labels = input.labels as Array<string | number>;
        const issue = data(await client.GET('/repos/{owner}/{repo}/issues/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(issue.updated_at, expectedUpdatedAt);
        const replaced = data(await client.PUT('/repos/{owner}/{repo}/issues/{index}/labels', {
          params: { path: { owner, repo, index } }, body: { labels }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index, labels: replaced.map((label) => ({ id: label.id, name: label.name, color: label.color })) };
      },
    },
    {
      name: 'createPullRequest', version: '1.0.0', label: 'Create Pull Request',
      // NO head-revision pin, deliberately (#11 review 2965 P1-3): the Forgejo
      // create-PR API resolves head/base by BRANCH REF at POST time and offers
      // no CAS/immutable-head creation, so a GET-then-POST "expected head"
      // check is a raceable preflight, not a state binding — and a Forgejo PR
      // is branch-tracking by platform semantics anyway (its head follows
      // every later push), so a create-time SHA pin would be theater even
      // when it won the race. The Action is honest instead: creation is
      // branch-scoped, the RESULT reports the server-resolved head revision,
      // and the revision binding of the review flow lives server-side in
      // reviewPullRequest's `commit_id`.
      description: 'Create one pull request from a same-repository branch. Creation is branch-scoped (a Forgejo pull request tracks its head branch); the result reports the head revision the server resolved. The revision-bound decision is reviewPullRequest.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.pull-request.create', 'forgejo.pull-request', []),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, title: { type: 'string', minLength: 1, maxLength: 255, description: 'Pull request title.' },
        body: { type: 'string', maxLength: 262_144, default: '', description: 'Pull request body (Markdown); empty allowed.' },
        head: { type: 'string', minLength: 1, maxLength: 255, description: 'Source branch to merge FROM (e.g. "feature/x").' }, base: { type: 'string', minLength: 1, maxLength: 255, description: 'Target branch to merge INTO (e.g. "main").' },
      }, ['owner', 'repo', 'title', 'head', 'base', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo');
        const title = string(input, 'title'); const body = typeof input.body === 'string' ? input.body : '';
        const head = string(input, 'head'); const base = string(input, 'base');
        const pull = data(await client.POST('/repos/{owner}/{repo}/pulls', {
          params: { path: { owner, repo } }, body: { title, body, head, base }, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: pull.number, title: pull.title, state: pull.state, url: pull.html_url,
          head: { branch: pull.head?.ref, revision: pull.head?.sha }, base: { branch: pull.base?.ref, revision: pull.base?.sha } };
      },
    },
    {
      name: 'updatePullRequestMetadata', version: '1.0.0', label: 'Update Pull Request Metadata',
      description: 'Update only title and body; state, base, assignees, labels and milestone are separate Actions.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.pull-request.metadata.update', 'forgejo.pull-request', ['expected-updated-at']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: 255 }, body: { type: 'string', maxLength: 262_144 },
        expectedUpdatedAt: { type: 'string', minLength: 1, maxLength: 64 },
      }, ['owner', 'repo', 'index', 'expectedUpdatedAt', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const title = typeof input.title === 'string' ? input.title : undefined;
        const body = typeof input.body === 'string' ? input.body : undefined;
        if (title === undefined && body === undefined) throw new Error('at least one of title or body is required');
        const expectedUpdatedAt = string(input, 'expectedUpdatedAt');
        const current = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        assertExpectedRevision(current.updated_at, expectedUpdatedAt);
        const pull = data(await client.PATCH('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } }, body: { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) },
          idempotent: true, ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: pull.number, title: pull.title, body: pull.body, state: pull.state, url: pull.html_url, updatedAt: pull.updated_at };
      },
    },
    {
      name: 'closePullRequest', version: '1.0.0', label: 'Close Pull Request',
      description: 'Close, but never merge, one pull request at an expected head revision.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.pull-request.close', 'forgejo.pull-request', ['expected-head-revision']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1 },
        expectedHeadRevision: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['owner', 'repo', 'index', 'expectedHeadRevision', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        await pullAtExpectedHead(client, owner, repo, index, string(input, 'expectedHeadRevision'), signal);
        const pull = data(await client.PATCH('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } }, body: { state: 'closed' }, idempotent: true,
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index: pull.number, state: pull.state, url: pull.html_url, closed: pull.state === 'closed' };
      },
    },
    {
      name: 'reviewPullRequest', version: '1.0.0', label: 'Review Pull Request',
      description: 'Submit one whole-pull-request review pinned to the expected head revision.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: checkpoint('forgejo.collaborate.pull-request.review.create', 'forgejo.pull-request-review', ['expected-head-revision']),
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1, description: 'The pull request number shown in Forgejo (the N in /pulls/N).' },
        event: { enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'Review verdict: APPROVE, REQUEST_CHANGES, or COMMENT (no verdict).' },
        body: { type: 'string', maxLength: 262_144, default: '', description: 'Review text (Markdown); empty allowed for APPROVE.' },
        expectedHeadRevision: { type: 'string', minLength: 1, maxLength: 255, description: 'The head commit SHA the review applies to; the review is bound to it and refused if the head has moved.' },
      }, ['owner', 'repo', 'index', 'event', 'expectedHeadRevision', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const event = string(input, 'event') as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
        const body = typeof input.body === 'string' ? input.body : '';
        const expectedHeadRevision = string(input, 'expectedHeadRevision');
        await pullAtExpectedHead(client, owner, repo, index, expectedHeadRevision, signal);
        const review = data(await client.POST('/repos/{owner}/{repo}/pulls/{index}/reviews', {
          params: { path: { owner, repo, index } },
          body: { event: toForgejoReviewEvent(event), body, commit_id: expectedHeadRevision },
          ...(signal ? { signal } : {}),
        }));
        return { owner, repo, index, reviewId: review.id, state: review.state, body: review.body,
          reviewer: review.user?.login, submittedAt: review.submitted_at, url: review.html_url };
      },
    },
    {
      // #16 §5 — the guarded merge. This is the ONLY merge primitive the Phase B
      // Agent surface exposes; there is deliberately no unguarded merge escape
      // hatch. The guard fails CLOSED, at the Widget, on every one of #16's
      // conditions BEFORE it POSTs the merge, and the merge POST then binds the
      // same head server-side (head_commit_id) with force_merge:false so the
      // server independently refuses a stale or protection-failing merge. The
      // Widget declares facts and enforces mechanics; it does NOT infer Merge
      // Authority from authorship or credential — raising Confirmation/Approval
      // on this HIGH-risk Checkpoint is the Platform's policy decision.
      name: 'guardedMergePullRequest', version: '1.0.0', label: 'Guarded Merge Pull Request',
      description: 'Merge one open pull request only when the guarded decision holds against the exact head: PR open and mergeable, an approving review bound to the current head (stale approvals never qualify), no blocking request-changes, and every required status check green. Branch deletion is deliberately not performed; force-merge is never used.',
      capability: 'forgejo.collaborate', credentialProfile: 'collaboration',
      checkpoint: {
        id: 'forgejo.collaborate.pull-request.merge.guarded', version: '1.0.0', resourceType: 'forgejo.pull-request',
        risk: 'high', sideEffect: 'write', credentialProfile: 'collaboration',
        localPreconditions: ['schema-valid', 'human-reason', 'expected-head-revision', 'open-unmerged', 'mergeable',
          'qualifying-review', 'no-blocking-request-changes', 'required-checks-green', 'no-force-merge'],
      },
      inputSchema: schema({
        ...OWNER_REPO, ...REASON, index: { type: 'integer', minimum: 1, description: 'The pull request number shown in Forgejo (the N in /pulls/N).' },
        expectedHeadRevision: { type: 'string', minLength: 1, maxLength: 255, description: 'The head commit SHA you reviewed; the merge is refused if the head has moved since.' },
        strategy: { enum: ['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'], description: 'Merge strategy: merge (merge commit), rebase, rebase-merge, squash, or fast-forward-only.' },
        requiredStatusChecks: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 100, uniqueItems: true, description: 'Status-check context names that must be successful on the head commit before merging.' },
        title: { type: 'string', maxLength: 255, description: 'Merge commit title (merge/squash strategies); defaults to Forgejo\'s.' }, message: { type: 'string', maxLength: 262_144, description: 'Merge commit message body (merge/squash strategies).' },
      }, ['owner', 'repo', 'index', 'expectedHeadRevision', 'strategy', 'reason']),
      async execute(input, { client, signal }) {
        const owner = string(input, 'owner'); const repo = string(input, 'repo'); const index = int(input, 'index');
        const expectedHead = string(input, 'expectedHeadRevision');
        const strategy = string(input, 'strategy') as 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'fast-forward-only';

        // 1. open + unmerged + exact head + mergeable.
        const pull = data(await client.GET('/repos/{owner}/{repo}/pulls/{index}', {
          params: { path: { owner, repo, index } }, ...(signal ? { signal } : {}),
        }));
        if (pull.state !== 'open' || pull.merged === true) {
          throw new WidgetActionError('PRECONDITION_FAILED', 'pull request is not open and unmerged');
        }
        assertExpectedRevision(pull.head?.sha, expectedHead);
        if (pull.mergeable !== true) {
          throw new WidgetActionError('PRECONDITION_FAILED', `pull request is not mergeable (mergeable=${String(pull.mergeable)})`);
        }
        const baseBranch = pull.base?.ref;

        // 2. a revision-bound approving review, no blocking request-changes.
        // The LATEST DECISION review per reviewer decides. Only APPROVED and
        // REQUEST_CHANGES carry a decision: a later COMMENT (or any other
        // non-decision event) must never clear an earlier request-changes —
        // treating it as one fails OPEN (#17 review 3066). A review the
        // platform dismissed stops counting entirely (that is the sanctioned
        // unblock path). An approval superseded by a later request-changes does
        // not count, and a stale approval on an old head never qualifies
        // (#16 §5). ALL reviews are read (see listAllPullReviews) — a blocking
        // review on a later page must never be missed.
        const reviews = await listAllPullReviews(client, owner, repo, index, signal);
        const latestByReviewer = new Map<string, { state: string | undefined; commit_id: string | undefined; submitted_at: string | undefined }>();
        for (const review of reviews) {
          if (review.state !== 'APPROVED' && review.state !== 'REQUEST_CHANGES') continue;
          if (review.dismissed === true) continue;
          const key = review.user?.login ?? `#${review.id ?? 'anon'}`;
          const prev = latestByReviewer.get(key);
          const at = review.submitted_at ?? '';
          if (!prev || at >= (prev.submitted_at ?? '')) {
            latestByReviewer.set(key, { state: review.state, commit_id: review.commit_id, submitted_at: review.submitted_at });
          }
        }
        const blocking = [...latestByReviewer.entries()].filter(([, r]) => r.state === 'REQUEST_CHANGES').map(([who]) => who);
        if (blocking.length > 0) {
          throw new WidgetActionError('PRECONDITION_FAILED', `a blocking request-changes review is unresolved (reviewers: ${blocking.join(', ')})`);
        }
        const approving = [...latestByReviewer.entries()]
          .filter(([, r]) => r.state === 'APPROVED' && r.commit_id === expectedHead)
          .map(([who]) => who);
        if (approving.length === 0) {
          throw new WidgetActionError('PRECONDITION_FAILED', `no approving review is bound to the current head revision ${expectedHead} (stale approvals on an earlier head do not qualify)`);
        }

        // 3. required status checks green. The required set is the union of the
        // caller's declared contexts and, where readable, the base branch's
        // protected required contexts. When the set is non-empty every context
        // must be present and success; a missing or pending check fails closed.
        const requiredContexts = new Set<string>(Array.isArray(input.requiredStatusChecks) ? input.requiredStatusChecks as string[] : []);
        let protectionReadable = false;
        if (baseBranch) {
          try {
            const protection = data(await client.GET('/repos/{owner}/{repo}/branch_protections/{name}', {
              params: { path: { owner, repo, name: baseBranch } }, ...(signal ? { signal } : {}),
            }));
            protectionReadable = true;
            if (protection.enable_status_check && Array.isArray(protection.status_check_contexts)) {
              for (const ctx of protection.status_check_contexts) requiredContexts.add(ctx);
            }
          } catch {
            // The collaboration credential may not read branch protection. The
            // preflight then covers only the caller-declared contexts; the
            // server-side merge (force_merge:false) remains the protection
            // backstop.
            protectionReadable = false;
          }
        }
        if (requiredContexts.size > 0) {
          const combined = data(await client.GET('/repos/{owner}/{repo}/commits/{ref}/status', {
            params: { path: { owner, repo, ref: expectedHead }, query: { page: 1, limit: 100 } }, ...(signal ? { signal } : {}),
          }));
          const latestState = new Map<string, string | undefined>();
          for (const s of combined.statuses ?? []) {
            if (typeof s.context === 'string') latestState.set(s.context, s.status);
          }
          for (const ctx of requiredContexts) {
            const state = latestState.get(ctx);
            if (state !== 'success') {
              throw new WidgetActionError('PRECONDITION_FAILED', `required status check "${ctx}" is not success (state=${state ?? 'missing'})`);
            }
          }
        }

        // 4. server-bound merge: head_commit_id re-binds the exact head and
        // force_merge:false keeps every server-side protection in force.
        await client.POST('/repos/{owner}/{repo}/pulls/{index}/merge', {
          params: { path: { owner, repo, index } },
          body: {
            Do: strategy, head_commit_id: expectedHead, force_merge: false, delete_branch_after_merge: false,
            ...(typeof input.title === 'string' ? { MergeTitleField: input.title } : {}),
            ...(typeof input.message === 'string' ? { MergeMessageField: input.message } : {}),
          },
          ...(signal ? { signal } : {}),
        });
        return {
          owner, repo, index, merged: true, mergedHeadRevision: expectedHead, strategy,
          approvingReviewers: approving,
          requiredChecks: { contexts: [...requiredContexts].sort(), protectionReadable, verified: requiredContexts.size > 0 },
        };
      },
    },
  ];
}
