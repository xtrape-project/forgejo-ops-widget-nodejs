import { createHash } from 'node:crypto';
import { STATIC_RESOURCE_EXTRACTOR_MEDIA_TYPE, type CheckpointDefinition, type CheckpointVersionId } from '@xtrape/contracts';

/**
 * The governed Checkpoint layer for the Forgejo Ops reference Widget. It maps a
 * bounded subset of the Forgejo domain Actions onto exact, immutable
 * `@xtrape/contracts` Checkpoints — the same public Contracts/Connector boundary
 * the Linux Ops reference Widget uses (docs#262 H1). It grew in bounded slices:
 * #7's read-only trio, #10's two collaboration writes for the dual-identity
 * plan (`pull-request.create`, `pull-request-review.create`), and #16's Phase B
 * Agent development loop — one READ context snapshot plus the writes a task
 * needs from branch through corrective commit, Issue evidence and a GUARDED
 * merge (`pull-request.merge.guarded`, the only merge primitive; the unguarded
 * `mergePullRequest` action stays dormant inventory). Administration and
 * control-plane breadth (#1) stay out; every write is served only when the
 * bounded allowlist names it, which is also how the #10 dual-identity role
 * split is expressed per instance.
 *
 * Each Checkpoint declares its truthful `sideEffect` class, an exact
 * normalized Forgejo Resource (service -> owner -> repository -> object), and
 * binds its governed Action by `action.actionId` (the Service-edge invariant of
 * architecture/19 §3.1). This module owns no credential, target or business
 * state; it is a pure builder over the Action catalog.
 */

export const STATIC_EXTRACTOR_MEDIA_TYPE = STATIC_RESOURCE_EXTRACTOR_MEDIA_TYPE;
const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const PLACEHOLDER_OUTPUT_SCHEMA_BYTES = '{"type":"object"}';
export const EMPTY_INPUT_SCHEMA_BYTES = '{"type":"object"}';

/**
 * RFC 8785-equivalent canonical JSON serializer (sorted keys, no insignificant
 * whitespace). The bytes it produces are the digest preimage for both schema
 * records and resource-extractor artifacts, so two conformant implementations
 * hash identical documents to the same digest.
 */
export function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(',')}}`;
}

const sha256 = (bytes: string): string => `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;

// --- Resource-extraction artifacts -----------------------------------------
// The normalized Resource of ALL three reference reads is the REPOSITORY:
// service -> owner(/owner) -> repository(/repo). The issue / pull-request
// INDEX is content addressing WITHIN that resource, not a finer authorization
// grain — and it could not be a segment anyway: the static extractor resolves
// only STRING pointer values (platform-ce resource-extractor `type-mismatch`,
// found live in the m1 self-test), while `index` is an integer by domain
// truth. Per-object authorization granularity, if it is ever wanted, is
// future target-admission work, not a reason to bend the schema.

/** What a Checkpoint's Resource is: a repository named by the input, or the Service itself (its own configuration, #32). */
type ResourceTarget = 'repository' | 'service';

interface ArtifactSegment {
  type: string;
  id: { kind: 'literal'; value: string } | { kind: 'pointer'; pointer: string };
}

// SINGLE-TARGET INVARIANT (#19). The `service` segment is the serviceId, and
// nothing in the identity encodes the Forgejo ORIGIN. So the SAME serviceId
// deployed against two Forgejo origins produces identical artifact bytes,
// identical digest, and therefore the SAME normalized governed Resource —
// `service/owner/repo` on origin A would collapse onto `service/owner/repo` on
// origin B. 0.8.x is single-target by this invariant: one serviceId names one
// origin, and a second origin MUST use a distinct serviceId. This is why the
// Widget carries no target-id knob (config.ts): the only honest way to address
// a second origin is a second serviceId. Real multi-target support — binding
// the origin into the Resource identity as an admitted target segment — is
// future target-admission work and a versioned artifact change, not a silent
// widening of this one.
function artifactBytes(serviceId: string, target: ResourceTarget = 'repository'): string {
  const segments: ArtifactSegment[] =
    target === 'service'
      // The Service's own configuration (forgejo-ops#32): the Resource IS the
      // Service — one literal segment, nothing read from the input.
      ? [{ type: 'service', id: { kind: 'literal', value: serviceId } }]
      : [
          { type: 'service', id: { kind: 'literal', value: serviceId } },
          { type: 'owner', id: { kind: 'pointer', pointer: '/owner' } },
          { type: 'repository', id: { kind: 'pointer', pointer: '/repo' } },
        ];
  return canon({ artifactKind: 'static-resource-extractor', contractVersion: 1, segments });
}

export interface ResourceArtifact {
  bytesJson: string;
  digest: string;
}

/** Every resource-extractor artifact the bounded governed profile references. */
export function resourceArtifacts(serviceId: string): ResourceArtifact[] {
  return (['repository', 'service'] as const).map((target) => {
    const bytesJson = artifactBytes(serviceId, target);
    return { bytesJson, digest: sha256(bytesJson) };
  });
}

function artifactDigestFor(serviceId: string, target: ResourceTarget = 'repository'): string {
  return sha256(artifactBytes(serviceId, target));
}

/**
 * Project an Action's input schema onto the Platform's ENFORCEABLE subset
 * (platform-ce src/core/json-schema-subset.ts): top-level `type` /
 * `properties` / `required` / `additionalProperties`, and per-property `type`
 * only. The Checkpoint's admitted schema is the contract the Platform
 * ENFORCES on every governed invocation, and the enforcement build fails
 * closed on any keyword it cannot enforce — a richer schema there is not
 * stricter, it is EXECUTION_UNAVAILABLE. The richer constraints
 * (minLength/maxLength/minimum/…) remain on the Widget's own Action surface
 * and in its execute-time validation: local narrowing, exactly where
 * narrowing belongs.
 *
 * ANNOTATIONS travel (Widget Design Conventions §5; platform-ce#306): `title`
 * and `description` at the root and on every property assert nothing and are
 * admitted by the Platform as such — and the admitted record is exactly what
 * Exposure projects to an AI host (exposure#48). Stripping them made every
 * governed operation a contract nobody could read (found live 2026-09-06).
 */
const ANNOTATIONS = ['title', 'description'] as const;
function annotationsOf(node: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ANNOTATIONS) if (typeof node[k] === 'string' && (node[k] as string).trim()) out[k] = node[k] as string;
  return out;
}

export function enforceableInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const projected: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties)) {
    // A string enum (e.g. reviewPullRequest's `event`) has no `type` keyword;
    // its enforceable projection is `string` — every member is one. Anything
    // with neither `type` nor an all-string enum cannot be projected onto the
    // enforceable subset and fails CLOSED here, at build: an admitted `{}`
    // constraint would silently enforce nothing.
    const type =
      prop['type'] ??
      (Array.isArray(prop['enum']) && prop['enum'].length > 0 && prop['enum'].every((v) => typeof v === 'string')
        ? 'string'
        : undefined);
    if (type === undefined) {
      throw new Error(`input property "${name}" projects onto no enforceable type (no \`type\`, no all-string \`enum\`)`);
    }
    projected[name] = { type, ...annotationsOf(prop) };
  }
  return {
    ...annotationsOf(schema),
    type: 'object',
    properties: projected,
    ...(Array.isArray(schema['required']) ? { required: schema['required'] } : {}),
    additionalProperties: false,
  };
}

// --- The frozen Action -> Checkpoint mapping table -------------------------

interface StaticRow {
  action: string;
  checkpointId: string;
  checkpointVersion: string;
  target: ResourceTarget;
  sideEffect: CheckpointDefinition['sideEffect'];
  risk: CheckpointDefinition['risk'];
  input: CheckpointDefinition['sensitivity']['inputUpperBound'];
  output: CheckpointDefinition['sensitivity']['outputUpperBound'];
  /**
   * The declared local preconditions frozen into the Checkpoint. Present only on
   * the #16 Phase B rows: the original 5 rows omit it and keep the historical
   * ternary in buildCheckpointSet, so their published, immutable bytes are
   * unchanged. Each string names a fail-closed gate the Widget actually enforces
   * at execute time.
   */
  preconditions?: readonly string[];
}

/**
 * The governed reference set: the reads (#7 / #16 / list-first) and the writes
 * (#10 / #16). Reads are READ_ONLY / LOW; the writes carry their own
 * classification below. Bounds are INTERNAL under the owner's classification
 * rulings (2026-09-06: repository metadata and issue/PR content are INTERNAL,
 * what the credential can see, Panel = Exposure).
 *
 * No structural public-repository gate any more (#34, owner ruling
 * 2026-09-07): whether a write may land is the FORGEJO TOKEN's permission —
 * a 403 is the refusal, reported as such — and which repositories a session
 * may reach at all is the Platform's exposure rule / entitlement. The
 * `repository-proven-public` gate the writes carried at 1.0.0 was never an
 * authorization device; it kept an INTERNAL bound truthful when the AI face
 * could carry nothing above INTERNAL (platform-ce#318 removed that ceiling),
 * and the reads had already left it on 2026-09-06. A published version's
 * preconditions are immutable, so each write's gate removal is a NEW version
 * (1.0.1).
 */
export const STATIC_CHECKPOINT_ROWS: readonly StaticRow[] = [
  // 1.0.1: the admitted input schema moved onto the Platform's enforceable
  // subset. 1.0.0 cited the richer Action schema, whose extra keywords the
  // enforcement build refuses (EXECUTION_UNAVAILABLE) — and a published
  // version's bytes are immutable, so the correction is a VERSION, not an
  // edit (the discipline linux-ops#81 froze).
  // LIST-FIRST reads (owner 2026-09-06, panel-ce#193 #3): their Resource is
  // the Service (no repository yet — that is what they answer), so they ride
  // the service-target extractor and skip the per-repository gate. ONE list
  // each, private entries included with visibility marked; listing metadata
  // is INTERNAL under the owner's classification ruling (2026-09-06).
  { action: 'listOrganizations', checkpointId: 'organization.list', checkpointVersion: '1.0.0', target: 'service', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  { action: 'listRepositories', checkpointId: 'repository.list', checkpointVersion: '1.0.0', target: 'service', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  // getRepository opens the rows the list shows — private ones included
  // (owner 2026-09-06: Panel and Exposure see the same list, visibility
  // marked; repository METADATA is INTERNAL under the owner's ruling), so it
  // runs behind no repository gate — nothing does since #34 (the token decides).
  { action: 'getRepository', checkpointId: 'repository.get', checkpointVersion: '1.0.2', target: 'repository', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  // The per-repository lists (panel-ce#193 #9): reached from a repository
  // row; listing metadata (numbers, titles, state) is INTERNAL under the
  // owner's ruling.
  { action: 'listIssues', checkpointId: 'issue.list', checkpointVersion: '1.0.0', target: 'repository', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  { action: 'listPullRequests', checkpointId: 'pull-request.list', checkpointVersion: '1.0.0', target: 'repository', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  // 1.0.2 (review 3155): the content reads open the rows the lists show —
  // private repositories included (owner 2026-09-06: what the credential can
  // see, Panel = Exposure). 1.0.1 ran behind the structural proven-public
  // gate; a published version's semantics are immutable, so the gate's
  // removal is a NEW version (the writes followed at 1.0.1, #34).
  { action: 'getIssue', checkpointId: 'issue.get', checkpointVersion: '1.0.2', target: 'repository', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  { action: 'getPullRequest', checkpointId: 'pull-request.get', checkpointVersion: '1.0.2', target: 'repository', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL' },
  // #10 write unfreeze — the TWO collaboration writes of the dual-identity
  // plan. Both are MUTATING; 1.0.1 (#34) dropped the proven-public gate —
  // the token decides. Their revision stories differ honestly (review 2965
  // P1-3): REVIEW is revision-BOUND server-side (the POST carries
  // `commit_id: expectedHeadRevision`, a second binding beyond the
  // preflight), while CREATE declares NO revision pin — Forgejo resolves
  // head/base by branch ref at POST time with no CAS-create, and a pull
  // request tracks its head branch; a create-time SHA pin would be a
  // raceable preflight dressed as a binding.
  { action: 'createPullRequest', checkpointId: 'pull-request.create', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: [] },
  { action: 'reviewPullRequest', checkpointId: 'pull-request-review.create', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: ['expected-head-revision'] },
  // #16 Phase B — the bounded governed Agent development loop. One READ context
  // snapshot exposed by default alongside the other reads, and the writes that
  // carry a task from branch through corrective commit, Issue evidence and
  // guarded merge. Every write is served ONLY when the allowlist names it
  // (isCheckpointExposed), so an upgrade never silently widens a deployment's
  // scope; the dual-identity role split (#10) is expressed by which of these a
  // given instance's allowlist names. Each row's `preconditions` are gates the
  // Widget enforces at execute time; no repository gate (#34: the token
  // decides, a Forgejo 403 is the refusal). The unguarded
  // `mergePullRequest` action stays dormant inventory — the ONLY governed merge
  // is `pull-request.merge.guarded`, HIGH-risk, whose fail-closed decision the
  // action enforces before a server-bound (head_commit_id, no force) merge.
    // 1.0.1 (review 3155): the proven-public gate left this read (owner ruling
  // 2026-09-06: the reads open what the credential can see). 1.0.0 declared
  // `repository-proven-public` and is immutable, so the change is a NEW
  // version whose declared preconditions match the actual gate (none); the
  // three older reads got 1.0.2 for the same reason.
  { action: 'getPullRequestContext', checkpointId: 'pull-request.context.get', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL', preconditions: [] },
  { action: 'createBranch', checkpointId: 'branch.create', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: ['expected-source-revision'] },
  { action: 'atomicCommitFiles', checkpointId: 'pull-request.change.commit', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: ['expected-head-revision', 'expected-file-revisions', 'protected-branch-deny'] },
  { action: 'createIssue', checkpointId: 'issue.create', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: [] },
  { action: 'commentIssue', checkpointId: 'issue-comment.create', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: [] },
  { action: 'setIssueState', checkpointId: 'issue.state.set', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'MEDIUM', input: 'INTERNAL', output: 'INTERNAL', preconditions: ['expected-updated-at'] },
  // forgejo-ops#32 — the Service's own target configuration. Resource = the
  // Service (service-target extractor). Reads are defaults; `target.set` is a
  // write: allowlist-only like every other write, and its credential input
  // is a protected field (input bound SECRET, never returned).
  { action: 'manageTarget', checkpointId: 'target.manage', checkpointVersion: '1.0.0', target: 'service', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL', preconditions: [] },
  { action: 'testTarget', checkpointId: 'target.test', checkpointVersion: '1.0.0', target: 'service', sideEffect: 'READ_ONLY', risk: 'LOW', input: 'INTERNAL', output: 'INTERNAL', preconditions: [] },
  { action: 'setTarget', checkpointId: 'target.set', checkpointVersion: '1.0.0', target: 'service', sideEffect: 'MUTATING', risk: 'HIGH', input: 'SECRET', output: 'INTERNAL', preconditions: ['target-probe-ok'] },
  { action: 'guardedMergePullRequest', checkpointId: 'pull-request.merge.guarded', checkpointVersion: '1.0.1', target: 'repository', sideEffect: 'MUTATING', risk: 'HIGH', input: 'INTERNAL', output: 'INTERNAL', preconditions: ['expected-head-revision', 'open-unmerged', 'mergeable', 'qualifying-review', 'no-blocking-request-changes', 'required-checks-green', 'no-force-merge'] },
];

const STATIC_BY_ACTION = new Map(STATIC_CHECKPOINT_ROWS.map((row) => [row.action, row]));
const STATIC_BY_CHECKPOINT = new Map(STATIC_CHECKPOINT_ROWS.map((row) => [row.checkpointId, row]));

/** The exact immutable Checkpoint identity an Action binds. */
/** The governed Resource an Action's Checkpoint is rooted at: `repository` = service → owner → repository (the row names owner/repo; no publicness precondition since #34); `service` = the Service itself, no repository in play. */
export function checkpointTargetFor(actionName: string): ResourceTarget {
  return STATIC_BY_ACTION.get(actionName)?.target ?? 'repository';
}


export function checkpointRefFor(serviceId: string, actionName: string): CheckpointVersionId {
  const row = STATIC_BY_ACTION.get(actionName);
  if (!row) throw new Error(`no governed Checkpoint is declared for action "${actionName}"`);
  return { serviceId, checkpointId: row.checkpointId, checkpointVersion: row.checkpointVersion };
}

// --- Bounded profile (same mechanism as linux-ops#81) ----------------------

/**
 * Parse `FORGEJO_OPS_BOUNDED_CHECKPOINTS`. ABSENT (undefined) means the
 * READ-ONLY reference set — NOT everything (review 2965 P1-1): the #10
 * writes exist in the table but are served only when an allowlist NAMES
 * them, so an existing deployment that swaps in this Widget build keeps
 * exactly the read surface it had (m1's baseline auto-merges a governed
 * service's published Checkpoints into the maintainer scope — a default
 * that quietly grew from 3 reads to reads+writes would be a silent
 * authority escalation there). A comma-separated allowlist is exact: it
 * narrows the reads and is the ONLY way a write is exposed.
 * PRESENT-BUT-EMPTY fails closed — a control whose whole job is to narrow
 * exposure must never degrade to a wider surface (mirrors linux-ops#81
 * review 2688).
 */
export function parseBoundedCheckpoints(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(
      'FORGEJO_OPS_BOUNDED_CHECKPOINTS is set but names no Checkpoint — a bounded profile that narrows exposure must not fall back to a wider surface. Unset it to serve the read-only reference set, or name each checkpointId to serve (writes are served ONLY when named).',
    );
  }
  for (const id of ids) {
    if (!STATIC_BY_CHECKPOINT.has(id)) {
      throw new Error(`FORGEJO_OPS_BOUNDED_CHECKPOINTS names unknown checkpointId "${id}"; known: ${[...STATIC_BY_CHECKPOINT.keys()].join(', ')}`);
    }
  }
  return new Set(ids);
}

export function isCheckpointExposed(checkpointId: string, bounded: ReadonlySet<string> | null): boolean {
  if (bounded !== null) return bounded.has(checkpointId);
  const row = STATIC_BY_CHECKPOINT.get(checkpointId);
  // Default = the reads. A CONFIDENTIAL read, should one ever be declared, is
  // served only when NAMED, like a write.
  return row !== undefined && row.sideEffect === 'READ_ONLY' && row.output !== 'CONFIDENTIAL';
}

// --- The builder -----------------------------------------------------------

export interface BuiltCheckpointSet {
  definitions: CheckpointDefinition[];
  schemaRecords: { bytesJson: string; dialect: string; digest: string }[];
}

/**
 * Build the immutable Checkpoint definitions + their content-addressed schema
 * records for the exposed rows. `inputSchemaFor` supplies each
 * Action's declared input schema (frozen into the Checkpoint); `profileDigest`
 * is the admitted execution-profile record the factory selected.
 */
export function buildCheckpointSet(opts: {
  serviceId: string;
  profileDigest: string;
  inputSchemaFor: (actionName: string) => Record<string, unknown> | undefined;
  bounded?: ReadonlySet<string> | null;
}): BuiltCheckpointSet {
  const bounded = opts.bounded ?? null;
  const schemaRecords = new Map<string, { bytesJson: string; dialect: string; digest: string }>();
  const addSchema = (bytesJson: string): string => {
    const digest = sha256(bytesJson);
    if (!schemaRecords.has(digest)) schemaRecords.set(digest, { bytesJson, dialect: SCHEMA_DIALECT, digest });
    return digest;
  };
  const outputDigest = addSchema(PLACEHOLDER_OUTPUT_SCHEMA_BYTES);

  const definitions: CheckpointDefinition[] = STATIC_CHECKPOINT_ROWS.filter((row) =>
    isCheckpointExposed(row.checkpointId, bounded),
  ).map((row) => {
    const inputSchema = opts.inputSchemaFor(row.action);
    return {
      contractVersion: 1,
      id: { serviceId: opts.serviceId, checkpointId: row.checkpointId, checkpointVersion: row.checkpointVersion },
      inputSchema: { schemaRecord: addSchema(inputSchema ? canon(enforceableInputSchema(inputSchema)) : EMPTY_INPUT_SCHEMA_BYTES) },
      outputSchema: { schemaRecord: outputDigest },
      resourceExtraction: {
        kind: 'extractor-artifact',
        artifactDigest: artifactDigestFor(opts.serviceId, row.target),
        executionProfileRecord: opts.profileDigest,
      },
      sideEffect: row.sideEffect,
      risk: row.risk,
      sensitivity: { inputUpperBound: row.input, outputUpperBound: row.output },
      // Reads are idempotent by construction. The writes are NOT: repeating
      // the same call posts another pull request / another review — the
      // expected-head-revision pin makes a stale replay REFUSE, which is a
      // different guarantee and must not be spelled as idempotence
      // (curator-git-widget#4 precedent).
      idempotency: row.sideEffect === 'READ_ONLY' ? 'IDEMPOTENT' : 'NON_IDEMPOTENT',
      delivery: 'AT_MOST_ONCE',
      retry: 'NONE',
      execution: 'SYNC',
      action: { actionId: row.action },
      // Every row declares its fail-closed local pins explicitly (#16, #34):
      // only the ones that actually hold — review's expected-head-revision is
      // enforced SERVER-SIDE via the POSTed commit_id; create deliberately
      // declares no revision pin (see the rows' comment). No row declares a
      // repository gate any more (#34): a published version's preconditions
      // are immutable, which is why the writes moved to 1.0.1.
      localPreconditions: [...(row.preconditions ?? [])],
    } satisfies CheckpointDefinition;
  });

  return { definitions, schemaRecords: [...schemaRecords.values()] };
}
