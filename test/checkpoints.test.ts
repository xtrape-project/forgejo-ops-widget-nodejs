import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CheckpointDefinitionSchema, StaticResourceExtractorArtifactSchema } from '@xtrape/contracts';
import { buildActionCatalog } from '../src/actions.js';
import {
  STATIC_CHECKPOINT_ROWS,
  buildCheckpointSet,
  canon,
  checkpointRefFor,
  isCheckpointExposed,
  parseBoundedCheckpoints,
  resourceArtifacts,
} from '../src/checkpoints.js';

const SERVICE_ID = 'forgejo-ops-widget-nodejs';
const PROFILE = `sha256:${'a'.repeat(64)}`;
const sha256 = (bytes: string): string => `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;

// The FULL surface needs the allowlist to NAME the writes (review 2965
// P1-1): an absent allowlist is the upgrade-safe read-only default.
const ALL_FIVE = parseBoundedCheckpoints('repository.get,issue.get,pull-request.get,pull-request.create,pull-request-review.create');

function build(bounded: ReadonlySet<string> | null = ALL_FIVE) {
  return buildCheckpointSet({ serviceId: SERVICE_ID, profileDigest: PROFILE, inputSchemaFor: () => ({ type: 'object' }), bounded });
}

describe('forgejo-ops Checkpoint layer (#7)', () => {
  it('the ADMITTED schema record keeps title/description (root and per property) and drops every other non-enforceable keyword — the record is what an AI host reads (exposure#48)', () => {
    const rich = {
      type: 'object', description: 'Read the bounded public metadata of one Forgejo repository.',
      properties: {
        owner: { type: 'string', minLength: 1, maxLength: 255, description: 'Repository owner.' },
        repo: { type: 'string', minLength: 1, maxLength: 255, title: 'Repository', description: 'Repository name.' },
        event: { enum: ['APPROVE', 'COMMENT'], description: 'Review verdict.' },
      },
      required: ['owner', 'repo'], additionalProperties: false,
    };
    const set = buildCheckpointSet({ serviceId: SERVICE_ID, profileDigest: PROFILE, inputSchemaFor: (n) => (n === 'getRepository' ? rich : { type: 'object' }), bounded: new Set(['repository.get']) });
    const def = set.definitions.find((d) => d.id.checkpointId === 'repository.get')!;
    const record = set.schemaRecords.find((r) => r.digest === def.inputSchema.schemaRecord)!;
    expect(JSON.parse(record.bytesJson)).toEqual({
      additionalProperties: false, description: 'Read the bounded public metadata of one Forgejo repository.',
      properties: {
        owner: { description: 'Repository owner.', type: 'string' },
        repo: { description: 'Repository name.', title: 'Repository', type: 'string' },
        event: { description: 'Review verdict.', type: 'string' },
      },
      required: ['owner', 'repo'], type: 'object',
    });
    expect(record.bytesJson).not.toContain('minLength');
    expect(record.bytesJson).not.toContain('enum');
  });

  it('builds the three reads and the two #10 writes, each admissible against the contract schema', () => {
    const { definitions } = build();
    expect(definitions.map((d) => d.id.checkpointId).sort()).toEqual([
      'issue.get', 'pull-request-review.create', 'pull-request.create', 'pull-request.get', 'repository.get',
    ]);
    for (const def of definitions) {
      // strict/closed contract schema accepts it → the Platform would admit it
      expect(() => CheckpointDefinitionSchema.parse(def)).not.toThrow();
      // Bounds INTERNAL under the owner's classification rulings (2026-09-06:
      // repository metadata and issue/PR content are INTERNAL, what the
      // credential can see, Panel = Exposure). No repository gate (#34).
      expect(def.sensitivity).toEqual({ inputUpperBound: 'INTERNAL', outputUpperBound: 'INTERNAL' });
      // the Service-edge invariant (architecture/19 §3.1): a non-self Checkpoint must bind an Action
      expect(def.action?.actionId).toBeTruthy();
      expect(def.id.serviceId).toBe(SERVICE_ID);
      expect(def.resourceExtraction.executionProfileRecord).toBe(PROFILE);
    }
  });

  it('the reads and the writes carry their own truthful classification', () => {
    const byId = new Map(build().definitions.map((d) => [d.id.checkpointId, d]));
    for (const id of ['repository.get', 'issue.get', 'pull-request.get']) {
      const def = byId.get(id)!;
      expect(def.sideEffect).toBe('READ_ONLY');
      expect(def.idempotency).toBe('IDEMPOTENT');
      expect(def.risk).toBe('LOW');
      expect(def.localPreconditions).toEqual([]);
      // 1.0.2 since review 3155: the gate left these reads, so their version moved — immutability is WHY it moved
      expect(def.id.checkpointVersion).toBe('1.0.2');
    }
    for (const id of ['pull-request.create', 'pull-request-review.create']) {
      const def = byId.get(id)!;
      expect(def.sideEffect).toBe('MUTATING');
      // Repeating the same call posts ANOTHER pull request / review — a
      // stale replay refusing (review) or landing branch-scoped (create) is
      // not idempotence and must not be spelled as it.
      expect(def.idempotency).toBe('NON_IDEMPOTENT');
      expect(def.risk).toBe('MEDIUM');
      expect(def.delivery).toBe('AT_MOST_ONCE');
      expect(def.retry).toBe('NONE');
      // 1.0.1 since #34: the proven-public gate left the writes (the token decides) — immutability is WHY the version moved
      expect(def.id.checkpointVersion).toBe('1.0.1');
    }
    // The revision stories differ HONESTLY (2965 P1-3): review's pin is
    // enforced server-side via the POSTed commit_id; create declares none —
    // Forgejo has no CAS-create and a PR tracks its branch, so declaring a
    // create-time pin would promise a binding the API cannot give.
    expect(byId.get('pull-request-review.create')!.localPreconditions).toEqual(['expected-head-revision']);
    expect(byId.get('pull-request.create')!.localPreconditions).toEqual([]);
    // #34: no served row declares a repository gate any more.
    for (const def of build().definitions) expect(def.localPreconditions).not.toContain('repository-proven-public');
  });

  it('the DEFAULT surface is the reads only — a write is served only when NAMED (2965 P1-1, #16)', () => {
    // absent allowlist ⇒ exactly the read surface (the #7 trio plus #16's
    // context snapshot); an existing deployment that swaps in this build gains
    // no write authority.
    const { definitions } = build(null);
    expect(definitions.map((d) => d.id.checkpointId).sort()).toEqual(['issue.get', 'issue.list', 'organization.list', 'pull-request.context.get', 'pull-request.get', 'pull-request.list', 'repository.get', 'repository.list', 'target.manage', 'target.test']);
    expect(isCheckpointExposed('target.set', null)).toBe(false); // the configuration WRITE is allowlist-only like every write
    expect(isCheckpointExposed('pull-request.create', null)).toBe(false);
    expect(isCheckpointExposed('pull-request-review.create', null)).toBe(false);
    expect(isCheckpointExposed('pull-request.merge.guarded', null)).toBe(false);
    expect(isCheckpointExposed('pull-request.change.commit', null)).toBe(false);
    expect(isCheckpointExposed('repository.get', null)).toBe(true);
    expect(isCheckpointExposed('pull-request.context.get', null)).toBe(true);
    // naming a write is the ONLY way it is exposed
    expect(isCheckpointExposed('pull-request.create', parseBoundedCheckpoints('pull-request.create'))).toBe(true);
    expect(isCheckpointExposed('pull-request.merge.guarded', parseBoundedCheckpoints('pull-request.merge.guarded'))).toBe(true);
  });

  it('binds each Checkpoint to the exact reviewed Action name', () => {
    const { definitions } = build();
    const byCp = new Map(definitions.map((d) => [d.id.checkpointId, d.action?.actionId]));
    expect(byCp.get('repository.get')).toBe('getRepository');
    expect(byCp.get('issue.get')).toBe('getIssue');
    expect(byCp.get('pull-request.get')).toBe('getPullRequest');
  });

  it('points every Checkpoint at the REPOSITORY-rooted Resource artifact, and every pointer resolves a STRING', () => {
    const artifacts = resourceArtifacts(SERVICE_ID);
    expect(artifacts).toHaveLength(2); // the repository-rooted artifact + the Service-rooted one (target.*, #32)
    const byDigest = new Map(artifacts.map((a) => [a.digest, a.bytesJson]));
    const { definitions } = build();
    for (const def of definitions) {
      const bytes = byDigest.get(def.resourceExtraction.artifactDigest);
      expect(bytes, `artifact for ${def.id.checkpointId}`).toBeTruthy();
      // bytes hash to the digest the Checkpoint cites
      expect(sha256(bytes!)).toBe(def.resourceExtraction.artifactDigest);
      const parsed = StaticResourceExtractorArtifactSchema.parse(JSON.parse(bytes!));
      // root is the service literal; then owner -> repository, and NOTHING
      // else: the issue/PR index is an INTEGER and the Platform's static
      // extractor resolves only STRING pointer values — a /index leaf made
      // issue.get and pull-request.get unauthorizable by construction
      // (extraction type-mismatch, found live in the m1 self-test).
      expect(parsed.segments[0]).toMatchObject({ type: 'service', id: { kind: 'literal', value: SERVICE_ID } });
      expect(parsed.segments.map((s) => s.type)).toEqual(['service', 'owner', 'repository']);
      // every pointer names a string-typed parameter in the admitted schema
      for (const seg of parsed.segments) {
        if (seg.id.kind === 'pointer') expect(['/owner', '/repo']).toContain(seg.id.pointer);
      }
    }
  });

  it('schema records are content-addressed and self-consistent', () => {
    const { definitions, schemaRecords } = build();
    const digests = new Set(schemaRecords.map((r) => r.digest));
    for (const r of schemaRecords) expect(sha256(r.bytesJson)).toBe(r.digest);
    for (const def of definitions) {
      expect(digests.has(def.inputSchema.schemaRecord)).toBe(true);
      expect(digests.has(def.outputSchema.schemaRecord)).toBe(true);
    }
  });

  it('the bounded allowlist narrows the definition set', () => {
    expect(build(parseBoundedCheckpoints('repository.get')).definitions.map((d) => d.id.checkpointId)).toEqual(['repository.get']);
  });

  it('serviceId is the sole Resource discriminator — same id collapses, a distinct id separates (#19 single-target)', () => {
    // The Resource identity encodes the serviceId but NOT the Forgejo origin, so
    // the SAME serviceId against two origins produces the SAME artifact digest
    // (they would collapse onto one governed Resource). The only mechanism that
    // separates two targets is a DISTINCT serviceId.
    expect(resourceArtifacts('svc-a')[0]!.digest).toBe(resourceArtifacts('svc-a')[0]!.digest);
    expect(resourceArtifacts('svc-a')[0]!.digest).not.toBe(resourceArtifacts('svc-b')[0]!.digest);
  });

  it('parseBoundedCheckpoints: absent = read-only reference set, present-empty fails closed, unknown id rejected', () => {
    expect(parseBoundedCheckpoints(undefined)).toBeNull();
    expect(() => parseBoundedCheckpoints('')).toThrow(/must not fall back to a wider surface/);
    expect(() => parseBoundedCheckpoints('  ,  ')).toThrow(/must not fall back to a wider surface/);
    expect(() => parseBoundedCheckpoints('repository.get,nope.get')).toThrow(/unknown checkpointId "nope.get"/);
    const b = parseBoundedCheckpoints('repository.get')!;
    expect(isCheckpointExposed('repository.get', b)).toBe(true);
    expect(isCheckpointExposed('issue.get', b)).toBe(false);
    expect(isCheckpointExposed('issue.get', null)).toBe(true);
  });

  it('checkpointRefFor rejects an action with no declared Checkpoint', () => {
    expect(() => checkpointRefFor(SERVICE_ID, 'deleteRepository')).toThrow(/no governed Checkpoint is declared/);
    expect(checkpointRefFor(SERVICE_ID, 'getRepository')).toEqual({ serviceId: SERVICE_ID, checkpointId: 'repository.get', checkpointVersion: '1.0.2' });
  });

  it('canon sorts keys and drops undefined (JCS-equivalent digest preimage)', () => {
    expect(canon({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canon({ a: undefined, b: 2 })).toBe('{"b":2}');
    // #7 trio + #10 pair + #16 Phase B (context.get, branch.create,
    // change.commit, issue.create, issue-comment.create, issue.state.set,
    // merge.guarded).
    // + the two list-first reads (organization.list, repository.list; owner 2026-09-06)
    // + issue.list / pull-request.list (panel-ce#193 #9)
    expect(STATIC_CHECKPOINT_ROWS.length).toBe(19);
  });
});

describe('the admitted input schema fits the Platform enforceable subset (#7 follow-up)', () => {
  it('projects every property to {type} only, keeping type/required/additionalProperties', () => {
    const { definitions, schemaRecords } = buildCheckpointSet({
      serviceId: SERVICE_ID, profileDigest: PROFILE,
      inputSchemaFor: () => ({ type: 'object', properties: { owner: { type: 'string', minLength: 1, maxLength: 255 }, index: { type: 'integer', minimum: 1, default: 1 } }, required: ['owner'], additionalProperties: false }),
    });
    const byDigest = new Map(schemaRecords.map((r) => [r.digest, r.bytesJson]));
    for (const def of definitions) {
      const schema = JSON.parse(byDigest.get(def.inputSchema.schemaRecord)!) as Record<string, unknown>;
      // Top-level: only the enforceable keywords.
      expect(Object.keys(schema).sort()).toEqual(['additionalProperties', 'properties', 'required', 'type']);
      // Per property: `type` alone — minLength/maxLength/minimum/default are the
      // Widget's own execute-time narrowing, and on the admitted schema they
      // would be EXECUTION_UNAVAILABLE, not extra safety.
      for (const prop of Object.values(schema['properties'] as Record<string, Record<string, unknown>>)) {
        expect(Object.keys(prop)).toEqual(['type']);
      }
      expect(schema['additionalProperties']).toBe(false);
    }
  });

  it('the REAL catalog schemas project cleanly for all five governed Actions', () => {
    const catalog = new Map(buildActionCatalog().map((a) => [a.name, a.inputSchema] as const));
    const { definitions, schemaRecords } = buildCheckpointSet({
      serviceId: SERVICE_ID, profileDigest: PROFILE,
      inputSchemaFor: (name) => catalog.get(name),
      bounded: ALL_FIVE,
    });
    expect(definitions).toHaveLength(5);
    const byDigest = new Map(schemaRecords.map((r) => [r.digest, r.bytesJson]));
    const schemaOf = (id: string) => {
      const def = definitions.find((d) => d.id.checkpointId === id)!;
      return JSON.parse(byDigest.get(def.inputSchema.schemaRecord)!) as { properties: Record<string, { type: string }>; required: string[] };
    };
    for (const def of definitions) {
      const schema = JSON.parse(byDigest.get(def.inputSchema.schemaRecord)!) as { properties: Record<string, { type: string }> };
      // owner/repo always — the repository-rooted Resource resolves from them;
      // each carries its description (the record is what an AI host reads).
      expect(schema.properties['owner']).toMatchObject({ type: 'string', description: expect.stringMatching(/owner/i) });
      expect(schema.properties['repo']).toMatchObject({ type: 'string', description: expect.stringMatching(/name/i) });
    }
    // the reads keep their integer index where they have one
    expect(schemaOf('issue.get').properties['index']).toMatchObject({ type: 'integer' });
    expect(schemaOf('pull-request.get').properties['index']).toMatchObject({ type: 'integer' });
    // create: branch-scoped by design — NO expectedHeadRevision input at all
    // (2965 P1-3: no CAS-create exists to honor one)
    const create = schemaOf('pull-request.create');
    expect(create.properties['expectedHeadRevision']).toBeUndefined();
    expect(create.required).toContain('head');
    expect(create.required).toContain('base');
    // review: the `event` STRING ENUM projects to plain `string` — the richer
    // enum stays the Widget's own execute-time narrowing (the Action refuses
    // anything outside APPROVE/REQUEST_CHANGES/COMMENT); an admitted `{}`
    // constraint would have enforced nothing.
    const review = schemaOf('pull-request-review.create');
    expect(review.properties['event']).toMatchObject({ type: 'string' });
    expect(review.properties['event']).not.toHaveProperty('enum');
    expect(review.required).toContain('expectedHeadRevision');
  });

  it('a property with neither type nor an all-string enum fails the build closed', () => {
    expect(() =>
      buildCheckpointSet({
        serviceId: SERVICE_ID, profileDigest: PROFILE,
        inputSchemaFor: () => ({ type: 'object', properties: { odd: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } }),
      }),
    ).toThrow(/projects onto no enforceable type/);
  });
});
