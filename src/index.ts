#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { serveCeService, type CeServiceActionDefinition, type CeSchemaRecordDefinition, type ServeCeServiceHandle } from '@xtrape/connector';
import type { CheckpointDefinition } from '@xtrape/contracts';

// `CheckpointFactoryContext` is not exported by @xtrape/connector; mirror the
// members the factory uses (SDK 0.8.5 dist shape).
interface CheckpointFactoryContext {
  instanceId: string;
  listExecutionProfiles(): Promise<{ profiles: Array<{ digest: string; bytesJson: string; profile: Record<string, unknown>; createdAt: string }> }>;
  publishResourceExtractorArtifact(input: { bytesJson: string; mediaType: string; digest?: string }): Promise<unknown>;
}
import { loadConfig, type WidgetConfig } from './config.js';
import { buildManifest } from './manifest.js';
import { TargetStore } from './target-store.js';
import { buildTargetCeActions } from './target-actions.js';
import { loadOrCreateInstanceId } from './instance.js';
import { buildActionCatalog } from './actions.js';
import { ForgejoClientProvider } from './credentials.js';
import { buildCeActions, servedCapabilities } from './service.js';
import {
  STATIC_EXTRACTOR_MEDIA_TYPE,
  buildCheckpointSet,
  checkpointRefFor,
  parseBoundedCheckpoints,
  resourceArtifacts,
} from './checkpoints.js';

interface GovernedServeOptions {
  actions: CeServiceActionDefinition[];
  schemaRecords: CeSchemaRecordDefinition[];
  /**
   * World A: a Checkpoint FACTORY — Connector 0.8.5 runs it on the instance
   * credential after registration, where the admitted execution profile can be
   * discovered and the extractor artifacts published. World B: a PLAIN array —
   * a listen-only service has neither registration nor factory context
   * (Connector refuses a factory outright), so the definitions ride the
   * authenticated descriptor for operator provisioning, built against the
   * operator-pinned `FORGEJO_OPS_EXECUTION_PROFILE_DIGEST`.
   */
  checkpoints: CheckpointDefinition[] | ((ctx: CheckpointFactoryContext) => Promise<CheckpointDefinition[]>);
}

/**
 * Build the governed serve options (actions + Checkpoints + schema records)
 * when a read-only Forgejo target is configured; return null to run inert
 * (health only). Exported so the World-A-factory / World-B-plain-array split
 * is directly testable (#8 review 2694: a factory in listen-only mode is
 * refused by the Connector at startup).
 */
export function buildGovernedServeOptions(config: WidgetConfig, store: TargetStore = new TargetStore(config.confDir, config.serviceId)): GovernedServeOptions | null {
  // The Forgejo target is runtime state in the TargetStore (forgejo-ops#32):
  // the env pair seeds it ONCE on first boot, then the store is the
  // authority and `setTarget` changes it without a restart. The Widget is
  // therefore governed whether or not a target is configured yet — the
  // target.* Checkpoints are how an operator configures it; the domain reads
  // answer PRECONDITION_FAILED until then.
  store.seedFromEnv(config.forgejoBaseUrl, config.collaborationToken);
  const bounded = parseBoundedCheckpoints(config.boundedCheckpoints);
  // Single-target invariant (checkpoints.ts, Resource identity): the target's
  // id IS the serviceId, which is also the `service` segment of every
  // governed Resource this Widget publishes. One serviceId therefore names
  // one Forgejo origin; a second origin needs a distinct serviceId. There is
  // deliberately no separate target-id knob — one would suggest a single
  // serviceId can safely address multiple origins, which it cannot until
  // target admission binds the origin into the Resource identity (future).
  // `setTarget` REPLACES the one target; it never adds a second.
  const provider = new ForgejoClientProvider(() => store.asForgejoTarget());
  const inputSchemaByName = new Map(buildActionCatalog().map((a) => [a.name, a.inputSchema] as const));
  // Every target Action contributes its schema to the DEFINITIONS regardless
  // of exposure: a definition is published for whatever the allowlist names,
  // and an admitted input schema of `{type:object}` (what an absent schema
  // becomes) is one the Platform's enforcement refuses (found live: target.set
  // answered EXECUTION_UNAVAILABLE when this map was built read-only).
  const targetSchemaByName = new Map(buildTargetCeActions({ store, refFor: (n) => checkpointRefFor(config.serviceId, n), exposed: () => true }).map((a) => [a.name, a.inputSchema as Record<string, unknown>] as const));
  const inputSchemaFor = (name: string): Record<string, unknown> | undefined => inputSchemaByName.get(name) ?? targetSchemaByName.get(name);

  const actions = buildCeActions({ serviceId: config.serviceId, provider, bounded, targetStore: store });
  // Schema records are digest-only (independent of the profile digest), so they
  // ride the serve OPTIONS in both directions.
  const schemaRecords = buildCheckpointSet({
    serviceId: config.serviceId,
    profileDigest: `sha256:${'0'.repeat(64)}`,
    inputSchemaFor,
    bounded,
  }).schemaRecords;

  if (config.transportMode === 'WORLD_B') {
    // Listen-only: no registration, no factory, no artifact publication route.
    // The definitions are built against the operator-pinned profile digest
    // (config fails closed without it) and ride the descriptor as a plain
    // array; the extractor-artifact bytes the definitions reference are the
    // operator's provisioning step — `scripts/print-extractor-artifacts.mjs`
    // prints exactly what must be admitted Platform-side.
    const pinned = config.executionProfileDigest;
    if (pinned === undefined) throw new Error('WORLD_B governed profile requires FORGEJO_OPS_EXECUTION_PROFILE_DIGEST');
    const set = buildCheckpointSet({ serviceId: config.serviceId, profileDigest: pinned, inputSchemaFor, bounded });
    return { actions, schemaRecords, checkpoints: set.definitions };
  }

  // World A: the factory runs on the instance credential after registration —
  // it selects the single admitted execution profile (or the pinned one) and
  // publishes the resource-extractor artifacts before returning the immutable
  // definitions.
  const checkpoints = async (ctx: CheckpointFactoryContext): Promise<CheckpointDefinition[]> => {
    const wanted = config.executionProfileDigest;
    const { profiles } = await ctx.listExecutionProfiles();
    const admitted = wanted ? profiles.filter((p) => p.digest === wanted) : profiles;
    if (admitted.length !== 1) {
      throw new Error(
        `expected exactly one admitted execution profile${wanted ? ` matching ${wanted}` : ''}, found ${admitted.length}`,
      );
    }
    const profileDigest = admitted[0]!.digest;
    for (const artifact of resourceArtifacts(config.serviceId)) {
      await ctx.publishResourceExtractorArtifact({
        bytesJson: artifact.bytesJson,
        mediaType: STATIC_EXTRACTOR_MEDIA_TYPE,
        digest: artifact.digest,
      });
    }
    const set = buildCheckpointSet({ serviceId: config.serviceId, profileDigest, inputSchemaFor, bounded });
    return set.definitions;
  };

  return { actions, schemaRecords, checkpoints };
}

export async function startWidget(config: WidgetConfig = loadConfig()): Promise<ServeCeServiceHandle> {
  const targetStore = new TargetStore(config.confDir, config.serviceId);
  const governed = buildGovernedServeOptions(config, targetStore);
  // The capability groups this deployment ACTUALLY serves, from each served
  // Action's true capability (reads are the default; a write group appears only
  // when the operator allowlist exposes one). The manifest tracks this, not a
  // fixed read-only claim (#18 review 3075) — and from the real capability, not
  // the coarse CeAction category (#18 review 3076).
  const served = governed ? servedCapabilities(governed.actions) : [];
  return serveCeService({
    // The SDK's listen-only constructor does not dial this value. Keep a
    // syntactically valid sentinel rather than inventing a Platform target.
    serverUrl: config.platformUrl ?? 'https://world-b-listen-only.invalid',
    manifest: buildManifest(config.serviceId, { servedCapabilities: served }),
    // The health summary names the target (URL only — never the credential)
    // so an operator can see which Forgejo this Service points at.
    handler: async () => ({ content: `forgejo-ops-widget healthy; target: ${targetStore.facts()?.baseUrl ?? 'not configured'}`, messageType: 'SUMMARY' }),
    ...(governed ? { actions: governed.actions, schemaRecords: governed.schemaRecords, checkpoints: governed.checkpoints } : {}),
    ...(config.registrationToken ? { registrationToken: config.registrationToken } : {}),
    ...(config.callbackToken ? { callbackToken: config.callbackToken } : {}),
    host: config.callbackHost,
    ...(config.callbackPort ? { port: config.callbackPort } : {}),
    ...(config.callbackAddress ? { address: config.callbackAddress } : {}),
    ...(config.transportMode === 'WORLD_A' ? { instanceId: loadOrCreateInstanceId(config.confDir) } : { listenOnly: true }),
    onReportRejected: ({ commandId, reason }) => {
      process.stderr.write(`forgejo-ops-widget: terminal report rejected for command ${commandId}: ${reason}\n`);
    },
    onTransportFatal: (error) => {
      process.stderr.write(`forgejo-ops-widget: transport stopped: ${error.message}\n`);
      // A terminated World A channel cannot receive new work. Let the process
      // supervisor restart with fresh provisioning rather than stay falsely
      // healthy behind a live callback listener.
      process.exit(1);
    },
  });
}

async function main(): Promise<void> {
  const handle = await startWidget();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void handle.close().finally(() => process.exit(0)));
  }
  process.stderr.write(`forgejo-ops-widget: started; callback ${handle.address}\n`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    process.stderr.write(`forgejo-ops-widget: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export * from './actions.js';
export * from './config.js';
export * from './credentials.js';
export * from './errors.js';
export * from './manifest.js';
export * from './policy.js';
export * from './provisioning.js';
export * from './registry.js';
export * from './service.js';
export * from './target-actions.js';
export * from './target-store.js';
export * from './types.js';
