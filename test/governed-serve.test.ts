import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointDefinitionSchema } from '@xtrape/contracts';
import { buildGovernedServeOptions } from '../src/index.js';
import { servedCapabilities } from '../src/service.js';
import type { WidgetConfig } from '../src/config.js';

const PINNED = `sha256:${'a'.repeat(64)}`;

// Overrides may pass an EXPLICIT `undefined` to knock a default out (the
// "runs inert" cases below). Under exactOptionalPropertyTypes a plain spread
// of that is illegal on WidgetConfig's required keys, so the merge DELETES
// explicitly-undefined keys instead — same runtime semantics the tests
// always meant (an absent optional), now spelled legally.
type ConfigOverrides = { [K in keyof WidgetConfig]?: WidgetConfig[K] | undefined };

function withOverrides(base: WidgetConfig, over: ConfigOverrides): WidgetConfig {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as WidgetConfig;
}

function worldA(over: ConfigOverrides = {}): WidgetConfig {
  return withOverrides({
    transportMode: 'WORLD_A',
    platformUrl: 'https://platform.example.test',
    registrationToken: 'reg',
    callbackToken: 'cb',
    callbackHost: '127.0.0.1',
    serviceId: 'forgejo-ops-widget-nodejs',
    confDir: mkdtempSync(join(tmpdir(), 'forgejo-ops-conf-')),
    forgejoBaseUrl: 'https://forgejo.example.test',
    collaborationToken: 'tok',
  }, over);
}

function worldB(over: ConfigOverrides = {}): WidgetConfig {
  return withOverrides({
    transportMode: 'WORLD_B',
    callbackToken: 'cb',
    callbackHost: '127.0.0.1',
    callbackPort: 8080,
    callbackAddress: 'https://forgejo-ops.example.test',
    serviceId: 'forgejo-ops-widget-nodejs',
    confDir: mkdtempSync(join(tmpdir(), 'forgejo-ops-conf-')),
    forgejoBaseUrl: 'https://forgejo.example.test',
    collaborationToken: 'tok',
    executionProfileDigest: PINNED,
  }, over);
}

describe('governed serve options by transport direction (#8 review 2694)', () => {
  it('is governed WITHOUT a target too (#32): the target.* reads and the default domain reads are served; setTarget only when named', () => {
    for (const cfg of [worldA({ forgejoBaseUrl: undefined, collaborationToken: undefined }), worldB({ forgejoBaseUrl: undefined, collaborationToken: undefined })]) {
      const governed = buildGovernedServeOptions(cfg);
      expect(governed).not.toBeNull();
      expect(governed!.actions.map((a) => a.name).sort()).toEqual(['getIssue', 'getPullRequest', 'getPullRequestContext', 'getRepository', 'listIssues', 'listOrganizations', 'listPullRequests', 'listRepositories', 'manageTarget', 'testTarget']);
    }
    const named = buildGovernedServeOptions(worldA({ forgejoBaseUrl: undefined, collaborationToken: undefined, boundedCheckpoints: 'target.manage,target.test,target.set' }));
    expect(named!.actions.map((a) => a.name).sort()).toEqual(['manageTarget', 'setTarget', 'testTarget']);
  });

  it('WORLD_A passes a Checkpoint FACTORY (the instance credential discovers the profile and publishes artifacts)', () => {
    const governed = buildGovernedServeOptions(worldA());
    expect(governed).not.toBeNull();
    expect(typeof governed!.checkpoints).toBe('function');
    // DEFAULT surface: the reads only — every write needs the allowlist to
    // name it (2965 P1-1, #16).
    expect(governed!.actions.map((a) => a.name).sort()).toEqual(['getIssue', 'getPullRequest', 'getPullRequestContext', 'getRepository', 'listIssues', 'listOrganizations', 'listPullRequests', 'listRepositories', 'manageTarget', 'testTarget']);
  });

  it('the writes join either direction only when the allowlist NAMES them', () => {
    const five = 'repository.get,issue.get,pull-request.get,pull-request.create,pull-request-review.create';
    const a = buildGovernedServeOptions(worldA({ boundedCheckpoints: five }));
    expect(a!.actions.map((x) => x.name).sort()).toEqual(['createPullRequest', 'getIssue', 'getPullRequest', 'getRepository', 'reviewPullRequest']);
    const b = buildGovernedServeOptions(worldB({ boundedCheckpoints: five }));
    expect((b!.checkpoints as { id: { checkpointId: string } }[]).map((d) => d.id.checkpointId).sort()).toEqual([
      'issue.get', 'pull-request-review.create', 'pull-request.create', 'pull-request.get', 'repository.get',
    ]);
  });

  it('the manifest capabilities aggregate from the ActionDefinition capability, not the coarse category (#18 review 3075/3076)', () => {
    const caps = (cfg: WidgetConfig): string[] => servedCapabilities(buildGovernedServeOptions(cfg)!.actions);
    // reads-only default ⇒ inspect only; the manifest can no longer claim read-only past this.
    expect(caps(worldA())).toEqual(['forgejo.inspect', 'forgejo.target']);
    // a collaboration write joins forgejo.collaborate.
    expect(caps(worldA({ boundedCheckpoints: 'repository.get,pull-request.merge.guarded' }))).toEqual(['forgejo.collaborate', 'forgejo.inspect']); // named allowlist: target.* absent by choice
    // branch.create / pull-request.change.commit bind `createBranch` /
    // `atomicCommitFiles`, which are forgejo.content Actions — served under the
    // coarse category 'collaborate', but the manifest MUST say forgejo.content.
    expect(caps(worldA({ boundedCheckpoints: 'repository.get,branch.create' }))).toEqual(['forgejo.content', 'forgejo.inspect']);
    expect(caps(worldA({ boundedCheckpoints: 'repository.get,pull-request.change.commit' }))).toEqual(['forgejo.content', 'forgejo.inspect']);
  });

  it('WORLD_B passes a PLAIN definitions array — Connector 0.8.5 refuses a factory in listen-only mode', () => {
    const governed = buildGovernedServeOptions(worldB());
    expect(governed).not.toBeNull();
    // The regression: passing the factory here made the governed World B
    // deployment fail at startup ("a checkpoints FACTORY needs a
    // registration ... a listen-only (World B) service passes the plain
    // array").
    expect(Array.isArray(governed!.checkpoints)).toBe(true);
    const definitions = governed!.checkpoints as unknown[];
    expect(definitions).toHaveLength(10);
    for (const def of definitions) {
      const parsed = CheckpointDefinitionSchema.parse(def);
      // Built against the operator-pinned admitted profile, not a placeholder.
      expect(parsed.resourceExtraction.executionProfileRecord).toBe(PINNED);
    }
    // Schema records ride beside the definitions for the descriptor.
    expect(governed!.schemaRecords.length).toBeGreaterThan(0);
  });

  it('WORLD_B without the pinned digest fails closed here too (belt to the config braces)', () => {
    expect(() => buildGovernedServeOptions(worldB({ executionProfileDigest: undefined }))).toThrow(
      /FORGEJO_OPS_EXECUTION_PROFILE_DIGEST/,
    );
  });

  it('the bounded allowlist narrows the World B descriptor set like the World A catalog', () => {
    const governed = buildGovernedServeOptions(worldB({ boundedCheckpoints: 'repository.get' }));
    const definitions = governed!.checkpoints as { id: { checkpointId: string } }[];
    expect(definitions.map((d) => d.id.checkpointId)).toEqual(['repository.get']);
    expect(governed!.actions.map((a) => a.name)).toEqual(['getRepository']);
  });
});

describe('target.set publishes its REAL input schema (found live: an empty admitted schema is unenforceable)', () => {
  it('the definition for target.set cites a schema record with baseUrl + collaborationToken, additionalProperties:false', () => {
    const governed = buildGovernedServeOptions(worldB({ forgejoBaseUrl: undefined, collaborationToken: undefined, boundedCheckpoints: 'target.set' }));
    const def = (governed!.checkpoints as Array<{ id: { checkpointId: string }; inputSchema: { schemaRecord: string } }>).find((d) => d.id.checkpointId === 'target.set')!;
    const record = governed!.schemaRecords.find((r) => r.digest === def.inputSchema.schemaRecord)!;
    const schema = JSON.parse(record.bytesJson) as { additionalProperties: boolean; properties: Record<string, unknown>; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['baseUrl', 'collaborationToken']);
    expect(schema.required).toEqual(['baseUrl']);
  });
});
