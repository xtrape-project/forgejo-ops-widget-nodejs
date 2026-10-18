import { randomUUID } from 'node:crypto';
import { buildActionCatalog } from '../dist/actions.js';
import { parseBoundedCheckpoints } from '../dist/checkpoints.js';
import { ForgejoClientProvider } from '../dist/credentials.js';
import { ActionRegistry } from '../dist/registry.js';
import { buildCeActions } from '../dist/service.js';

const baseUrl = process.env.FORGEJO_INTEGRATION_URL?.trim();
const allowMutations = process.env.FORGEJO_INTEGRATION_ALLOW_MUTATIONS === 'disposable-only';
const token = process.env.FORGEJO_INTEGRATION_TOKEN?.trim();
if (!baseUrl || !token) throw new Error('FORGEJO_INTEGRATION_URL and FORGEJO_INTEGRATION_TOKEN are required');
const integrationHost = new URL(baseUrl).hostname;
if (!allowMutations || !new Set(['forgejo', 'localhost', '127.0.0.1', '::1']).has(integrationHost)) {
  throw new Error('mutation integration is restricted to an explicitly marked disposable local/CI Forgejo host');
}
const suffix = randomUUID().slice(0, 8);
const organization = `xtrape-integration-${suffix}`;
const repository = 'widget-test';
const clients = new ForgejoClientProvider({ id: 'integration', baseUrl, credentials: { collaboration: token, administration: token } });
const registry = new ActionRegistry(buildActionCatalog());

// A raw Forgejo API call, used ONLY to provision a second reviewer identity
// (the widget's Action catalog deliberately has no user administration). Every
// governed step still goes through the widget's governed surface.
async function forgejoApi(method, path, { authToken, basicAuth, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (basicAuth) headers.authorization = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
  else headers.authorization = `token ${authToken ?? token}`;
  const res = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

// The positive E2E needs an INDEPENDENT approving identity (an account distinct
// from the author). #10 owns the production dual-instance deployment; here the
// second identity is a DISPOSABLE account created on the disposable CI/local
// Forgejo via the admin API, so the full approve → guarded-merge → close path
// actually runs (#17 review 3068). A caller may instead pin an existing account
// via FORGEJO_INTEGRATION_REVIEWER_TOKEN.
async function provisionReviewerToken(owner, repo) {
  const pinned = process.env.FORGEJO_INTEGRATION_REVIEWER_TOKEN?.trim();
  if (pinned) return pinned;
  const name = `phase-b-reviewer-${suffix}`;
  const password = `Pw-${randomUUID()}-${randomUUID()}`; // ephemeral, disposable account only
  await forgejoApi('POST', '/admin/users', { body: { username: name, email: `${name}@disposable.invalid`, password, must_change_password: false } });
  // The review must count: the reviewer is a repo collaborator with write.
  await forgejoApi('PUT', `/repos/${owner}/${repo}/collaborators/${name}`, { body: { permission: 'write' } });
  // Token creation authenticates as the user (not by admin token).
  const created = await forgejoApi('POST', `/users/${name}/tokens`, {
    basicAuth: `${name}:${password}`, body: { name: 'phase-b', scopes: ['all'] },
  });
  return created.sha1;
}
// The served-surface invariants of the CURRENT build (this line once asserted
// the pre-Checkpoint projection was empty, and kept failing the gate long
// after #7 served the read trio — a stale assertion, not a regression):
// the DEFAULT surface is exactly the #7 read trio, and a #10 write appears
// ONLY when the allowlist names it (review 2965 P1-1, asserted here at the
// integration layer too).
const serviceId = 'forgejo-ops-widget-nodejs';
const surface = (bounded) => buildCeActions({ serviceId, provider: clients, ...(bounded === undefined ? {} : { bounded }) })
  .map((action) => action.name).sort().join(',');
// The DEFAULT projection is the reads (the #7 trio plus #16's context snapshot);
// every write appears ONLY when the allowlist names it (2965 P1-1, #16).
if (surface(undefined) !== 'getIssue,getPullRequest,getPullRequestContext,getRepository,listIssues,listOrganizations,listPullRequests,listRepositories') {
  throw new Error(`the DEFAULT projection must be the reads, got: ${surface(undefined)}`);
}
if (surface(parseBoundedCheckpoints('pull-request.create,pull-request-review.create')) !== 'createPullRequest,reviewPullRequest') {
  throw new Error('a named allowlist must expose exactly the named writes');
}
if (surface(parseBoundedCheckpoints('pull-request.merge.guarded')) !== 'guardedMergePullRequest') {
  throw new Error('the guarded merge is served exactly when its Checkpoint is named');
}
async function fixture(name, input) {
  const action = registry.get(name);
  if (!action) throw new Error(`fixture Action is unavailable: ${name}`);
  return action.execute(registry.validate(name, input), { client: clients.forProfile(action.credentialProfile) });
}

await fixture('createOrganization', { username: organization, visibility: 'private', reason: 'disposable migration inventory validation' });
await fixture('createOrganizationRepository', { organization, name: repository, private: true, defaultBranch: 'main', autoInit: true, reason: 'disposable migration inventory validation' });
const main = await fixture('getBranch', { owner: organization, repo: repository, branch: 'main' });
const issue = await fixture('createIssue', { owner: organization, repo: repository, title: 'Integration issue', body: 'Created by the disposable migration inventory gate.', reason: 'disposable migration inventory validation' });
const label = await fixture('createLabel', { owner: organization, repo: repository, name: 'integration', color: '336699', description: 'integration fixture', reason: 'disposable migration inventory validation' });
await fixture('listLabels', { owner: organization, repo: repository });
await fixture('getLabel', { owner: organization, repo: repository, id: label.id });
await fixture('replaceIssueLabels', { owner: organization, repo: repository, index: issue.index, labels: [label.id], expectedUpdatedAt: issue.updatedAt, reason: 'disposable migration inventory validation' });
let currentIssue = await fixture('getIssue', { owner: organization, repo: repository, index: issue.index });
const milestone = await fixture('createMilestone', { owner: organization, repo: repository, title: 'Integration milestone', state: 'open', reason: 'disposable migration inventory validation' });
await fixture('listMilestones', { owner: organization, repo: repository, state: 'all' });
await fixture('getMilestone', { owner: organization, repo: repository, id: milestone.id });
await fixture('setIssueMilestone', { owner: organization, repo: repository, index: issue.index, milestoneId: milestone.id,
  expectedUpdatedAt: currentIssue.updatedAt, reason: 'disposable migration inventory validation' });
currentIssue = await fixture('getIssue', { owner: organization, repo: repository, index: issue.index });
await fixture('setIssueState', { owner: organization, repo: repository, index: issue.index, state: 'closed',
  expectedUpdatedAt: currentIssue.updatedAt, reason: 'disposable migration inventory validation' });
const updatedMilestone = await fixture('updateMilestone', { owner: organization, repo: repository, id: milestone.id,
  expectedUpdatedAt: milestone.updatedAt, description: 'updated integration fixture', reason: 'disposable migration inventory validation' });
await fixture('deleteMilestone', { owner: organization, repo: repository, id: milestone.id, expectedTitle: milestone.title,
  expectedUpdatedAt: updatedMilestone.updatedAt, confirmTitle: milestone.title, reason: 'remove integration fixture' });
await fixture('deleteLabel', { owner: organization, repo: repository, id: label.id, expectedName: label.name,
  confirmName: label.name, reason: 'remove integration fixture' });
const release = await fixture('createRelease', { owner: organization, repo: repository, tag: 'integration-v1', targetBranch: 'main',
  expectedTargetRevision: main.revision, name: 'Integration release', reason: 'disposable migration inventory validation' });
await fixture('listReleases', { owner: organization, repo: repository, includeDrafts: true, includePrereleases: true });
await fixture('getRelease', { owner: organization, repo: repository, id: release.id });
await fixture('deleteRelease', { owner: organization, repo: repository, id: release.id, expectedTag: release.tag,
  confirmTag: release.tag, reason: 'remove integration fixture' });
await fixture('createBranch', { owner: organization, repo: repository, sourceBranch: 'main', newBranch: 'integration-work', expectedSourceRevision: main.revision, reason: 'disposable migration inventory validation' });
const work = await fixture('getBranch', { owner: organization, repo: repository, branch: 'integration-work' });
const commit = await fixture('atomicCommitFiles', { owner: organization, repo: repository, branch: 'integration-work', expectedBranchRevision: work.revision,
  message: 'test: exercise atomic file API', reason: 'disposable migration inventory validation', files: [{ operation: 'create', path: 'integration.txt', content: 'disposable Forgejo inventory integration\n' }] });
// createPullRequest is branch-scoped by design (#11 P1-3: no CAS-create
// exists; a PR tracks its head branch) — no expectedHeadRevision input. The
// created PR's head must be the commit the fixture just landed, and the
// revision-bound decision is reviewPullRequest's server-side commit_id,
// exercised here against a real Forgejo.
const pull = await fixture('createPullRequest', { owner: organization, repo: repository, title: 'Integration PR', body: 'Real integration validation.', head: 'integration-work', base: 'main',
  reason: 'disposable migration inventory validation' });
if (pull.head.revision !== commit.commitRevision) throw new Error(`created PR head ${pull.head.revision} is not the landed commit ${commit.commitRevision}`);
await fixture('listPullRequests', { owner: organization, repo: repository, state: 'open' });
const review = await fixture('reviewPullRequest', { owner: organization, repo: repository, index: pull.index, event: 'COMMENT',
  body: 'Integration review pinned to the expected head.', expectedHeadRevision: commit.commitRevision, reason: 'disposable migration inventory validation' });
if (!review.reviewId) throw new Error('review submission returned no reviewId');
await fixture('createBranchProtection', { owner: organization, repo: repository, name: 'main', requiredApprovals: 1, blockOnRejectedReviews: true, reason: 'disposable migration inventory validation' });

// ── #16 Phase B — the governed Agent development loop against a real Forgejo ──
// Unlike the inventory sweep above (raw Action layer), this loop runs the Phase
// B steps through the WIDGET'S GOVERNED SERVED SURFACE (`buildCeActions` bound
// to the Phase B allowlist): every step goes through the exact governed execute
// path — the two-layer input validation, the structural proven-public
// repository gate, and the immutable Checkpoint binding — not a bare Action.
// That path only serves a PROVEN-public repository, so the loop runs on a
// dedicated public org/repo. (The remaining layer — Platform authorization
// intersection and audit projection — needs a running Platform and is the m1
// governed self-test's job, not a widget-local harness; #16 defers deployment
// to #10 for exactly this reason.)
const phaseBAllowlist = 'pull-request.context.get,branch.create,pull-request.change.commit,issue.create,issue-comment.create,issue.state.set,pull-request.create,pull-request-review.create,pull-request.merge.guarded';
const governedByName = new Map(
  buildCeActions({ serviceId, provider: clients, bounded: parseBoundedCheckpoints(phaseBAllowlist) }).map((action) => [action.name, action]),
);
async function governed(name, input, client = clients) {
  const surfaceActions = client === clients
    ? governedByName
    : new Map(buildCeActions({ serviceId, provider: client, bounded: parseBoundedCheckpoints(phaseBAllowlist) }).map((a) => [a.name, a]));
  const action = surfaceActions.get(name);
  if (!action) throw new Error(`the governed surface does not serve ${name}`);
  const result = await action.execute(input, {});
  if (!result || result.success !== true) throw new Error(`governed execute failed for ${name}: ${JSON.stringify(result)}`);
  return result.data;
}

// A dedicated PUBLIC org/repo: the governed surface serves proven-public
// repositories only.
const pubOrg = `xtrape-integration-pub-${suffix}`;
const pubRepo = 'phase-b-public';
await fixture('createOrganization', { username: pubOrg, visibility: 'public', reason: 'phase-b governed acceptance' });
await fixture('createOrganizationRepository', { organization: pubOrg, name: pubRepo, private: false, defaultBranch: 'main', autoInit: true, reason: 'phase-b governed acceptance' });

// A fresh task Issue drives the loop end to end: context → bounded corrective
// commit → PR → review → re-review at the new head → non-blocking finding routed
// to a follow-up → guarded merge → completion evidence → close. `getBranch`
// (a read helper) supplies expected revisions; every claimed governed step runs
// through `governed(...)`.
const taskIssue = await governed('createIssue', { owner: pubOrg, repo: pubRepo, title: 'Phase B task', body: 'Carry a bounded change through the governed loop.', reason: 'phase-b acceptance' });
const loopBase = await fixture('getBranch', { owner: pubOrg, repo: pubRepo, branch: 'main' });
await governed('createBranch', { owner: pubOrg, repo: pubRepo, sourceBranch: 'main', newBranch: 'phase-b-work', expectedSourceRevision: loopBase.revision, reason: 'phase-b working branch' });
let workBranch = await fixture('getBranch', { owner: pubOrg, repo: pubRepo, branch: 'phase-b-work' });
const change = await governed('atomicCommitFiles', { owner: pubOrg, repo: pubRepo, branch: 'phase-b-work', expectedBranchRevision: workBranch.revision,
  message: 'feat: phase-b bounded change', reason: 'phase-b bounded change', files: [{ operation: 'create', path: 'phase-b.txt', content: 'phase b\n' }] });
const loopPull = await governed('createPullRequest', { owner: pubOrg, repo: pubRepo, title: 'Phase B PR', body: `Closes #${taskIssue.index}.`, head: 'phase-b-work', base: 'main', reason: 'phase-b pull request' });
// Fresh decision snapshot: head is the landed commit, coherent, no approval yet.
const ctx = await governed('getPullRequestContext', { owner: pubOrg, repo: pubRepo, index: loopPull.index });
if (ctx.head.revision !== change.commitRevision) throw new Error(`context head ${ctx.head.revision} is not the landed commit ${change.commitRevision}`);
if (ctx.revisionCoherent !== true) throw new Error('context snapshot was not revision-coherent');
await governed('reviewPullRequest', { owner: pubOrg, repo: pubRepo, index: loopPull.index, event: 'COMMENT',
  body: 'One bounded fix, please.', expectedHeadRevision: change.commitRevision, reason: 'phase-b review finding' });
// ONE bounded corrective commit at the exact current head, then re-review the NEW head.
workBranch = await fixture('getBranch', { owner: pubOrg, repo: pubRepo, branch: 'phase-b-work' });
const corrective = await governed('atomicCommitFiles', { owner: pubOrg, repo: pubRepo, branch: 'phase-b-work', expectedBranchRevision: workBranch.revision,
  message: 'fix: address the bounded finding', reason: 'phase-b corrective commit', files: [{ operation: 'update', path: 'phase-b.txt', expectedFileRevision: change.files[0].revision, content: 'phase b corrected\n' }] });
await governed('reviewPullRequest', { owner: pubOrg, repo: pubRepo, index: loopPull.index, event: 'COMMENT',
  body: 'Re-reviewed the corrected head.', expectedHeadRevision: corrective.commitRevision, reason: 'phase-b re-review' });
// A non-blocking adjacent finding is routed to a follow-up Issue rather than
// widening this review boundary, and evidence is recorded on the PR.
const followUp = await governed('createIssue', { owner: pubOrg, repo: pubRepo, title: 'Phase B follow-up', body: 'Adjacent, non-blocking; routed out of the current review.', reason: 'phase-b route finding' });
await governed('commentIssue', { owner: pubOrg, repo: pubRepo, index: loopPull.index, body: `Merge-readiness evidence recorded; follow-up #${followUp.index}.`, reason: 'phase-b evidence' });

// The guarded merge REFUSES without a qualifying revision-bound approval —
// proven against the real Forgejo through the governed surface (the single most
// important #16 §5 property). Any of the guard's fail-closed reasons is an
// acceptable refusal here (right after a push Forgejo may still be computing
// mergeability); a wiring bug would surface as a differently-shaped error.
let guardRefusal;
try {
  await governed('guardedMergePullRequest', { owner: pubOrg, repo: pubRepo, index: loopPull.index, expectedHeadRevision: corrective.commitRevision, strategy: 'squash', reason: 'phase-b guarded merge (expected to refuse)' });
} catch (error) {
  guardRefusal = String(error?.message ?? error);
}
if (!guardRefusal || !/no approving review is bound to the current head|is not mergeable|a blocking request-changes|required status check/.test(guardRefusal)) {
  throw new Error(`guarded merge must refuse without a qualifying approval; got: ${guardRefusal ?? 'a successful merge'}`);
}

// The POSITIVE E2E — run unconditionally against real Forgejo with a provisioned
// INDEPENDENT reviewer identity (#17 review 3068): independent approve bound to
// the exact head → guarded merge succeeds → completion evidence → the originating
// Issue is closed. Every step goes through the governed surface.
const reviewerToken = await provisionReviewerToken(pubOrg, pubRepo);
const reviewerClients = new ForgejoClientProvider({ id: 'reviewer', baseUrl, credentials: { collaboration: reviewerToken } });
await governed('reviewPullRequest', { owner: pubOrg, repo: pubRepo, index: loopPull.index, event: 'APPROVE',
  body: 'Independent approval bound to the exact head.', expectedHeadRevision: corrective.commitRevision, reason: 'phase-b independent approval' }, reviewerClients);
// Wait for Forgejo to finish computing mergeability before the guarded decision.
for (let attempt = 0; attempt < 15; attempt += 1) {
  const ctxN = await governed('getPullRequestContext', { owner: pubOrg, repo: pubRepo, index: loopPull.index });
  if (ctxN.mergeable === true) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
const merged = await governed('guardedMergePullRequest', { owner: pubOrg, repo: pubRepo, index: loopPull.index, expectedHeadRevision: corrective.commitRevision, strategy: 'squash', reason: 'phase-b guarded merge' });
if (merged.merged !== true) throw new Error('guarded merge did not report a merge');
// Confirm real state: the PR is merged and the follow-up boundary held.
const mergedPull = await governed('getPullRequestContext', { owner: pubOrg, repo: pubRepo, index: loopPull.index });
if (mergedPull.merged !== true || mergedPull.state !== 'closed') throw new Error(`expected the PR merged+closed, got merged=${mergedPull.merged} state=${mergedPull.state}`);
await governed('commentIssue', { owner: pubOrg, repo: pubRepo, index: taskIssue.index, body: `Completed in PR #${loopPull.index}, merged at ${merged.mergedHeadRevision}.`, reason: 'phase-b completion evidence' });
const closingIssue = await fixture('getIssue', { owner: pubOrg, repo: pubRepo, index: taskIssue.index });
await governed('setIssueState', { owner: pubOrg, repo: pubRepo, index: taskIssue.index, state: 'closed', expectedUpdatedAt: closingIssue.updatedAt, reason: 'phase-b close on completion' });
const closedIssue = await fixture('getIssue', { owner: pubOrg, repo: pubRepo, index: taskIssue.index });
if (closedIssue.state !== 'closed') throw new Error(`originating issue was not closed, state=${closedIssue.state}`);
process.stdout.write('phase-b: full positive E2E passed through the governed surface (provisioned independent reviewer)\n');

await fixture('deleteRepository', { owner: pubOrg, repo: pubRepo, expectedRepositoryId: (await fixture('getRepository', { owner: pubOrg, repo: pubRepo })).id,
  confirmFullName: `${pubOrg}/${pubRepo}`, reason: 'remove phase-b fixture' });
await fixture('deleteRepository', { owner: organization, repo: repository, expectedRepositoryId: (await fixture('getRepository', { owner: organization, repo: repository })).id,
  confirmFullName: `${organization}/${repository}`, reason: 'remove integration fixture' });
process.stdout.write(`disposable Forgejo inventory integration passed (${organization})\n`);
