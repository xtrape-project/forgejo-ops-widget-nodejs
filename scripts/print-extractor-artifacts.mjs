#!/usr/bin/env node
/**
 * Print the resource-extractor artifacts the bounded read-only Checkpoints
 * reference, exactly as the Platform must hold them.
 *
 * World A publishes these itself (the Checkpoint factory runs on the instance
 * credential). A World B (listen-only) Widget has no publication route: the
 * authenticated descriptor carries the Checkpoint DEFINITIONS, and the
 * artifact bytes they reference by digest are the OPERATOR's provisioning
 * step. This prints them verbatim — digest, media type and canonical bytes —
 * so the operator admits precisely the content the definitions cite.
 *
 * The artifact digest is a function of the Service ID (checkpoints.ts,
 * single-target invariant #19), so this MUST run under the SAME Service ID as
 * the deployed Service. It resolves the Service ID with `resolveProvisioningServiceId`
 * (no silent default — fails closed if neither an argument nor the deployment's
 * `FORGEJO_OPS_WIDGET_SERVICE_ID` is set), so an operator can never provision
 * the package default by omission against a custom-Service-ID deployment
 * (review #3092).
 *
 * Usage — bind the EXACT deployed Service ID, one of:
 *   node scripts/print-extractor-artifacts.mjs <deployed-service-id>
 *   FORGEJO_OPS_WIDGET_SERVICE_ID=<deployed-service-id> node scripts/print-extractor-artifacts.mjs
 * (run `pnpm build` first)
 */
import {
  resourceArtifacts,
  STATIC_EXTRACTOR_MEDIA_TYPE,
  buildCheckpointSet,
  STATIC_CHECKPOINT_ROWS,
} from '../dist/checkpoints.js';
import { resolveProvisioningServiceId } from '../dist/provisioning.js';

let serviceId, serviceIdSource;
try {
  ({ serviceId, source: serviceIdSource } = resolveProvisioningServiceId({
    arg: process.argv[2],
    env: process.env.FORGEJO_OPS_WIDGET_SERVICE_ID,
  }));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const artifacts = resourceArtifacts(serviceId).map((artifact) => ({
  digest: artifact.digest,
  mediaType: STATIC_EXTRACTOR_MEDIA_TYPE,
  bytesJson: artifact.bytesJson,
}));

// Internal consistency guard only: the artifact-generation path
// (`resourceArtifacts`) and the definition-building path (`buildCheckpointSet`)
// must agree on the digest for a GIVEN Service ID, so the two code paths cannot
// silently diverge. This does NOT prove the Service ID matches the deployment —
// that binding is enforced upstream by `resolveProvisioningServiceId` failing
// closed and the operations runbook passing the exact deployed Service ID.
const printedDigests = new Set(artifacts.map((a) => a.digest));
const built = buildCheckpointSet({
  serviceId,
  profileDigest: `sha256:${'0'.repeat(64)}`,
  inputSchemaFor: () => undefined,
  bounded: new Set(STATIC_CHECKPOINT_ROWS.map((row) => row.checkpointId)),
});
const citedDigests = new Set(built.definitions.map((d) => d.resourceExtraction.artifactDigest));
for (const digest of citedDigests) {
  if (!printedDigests.has(digest)) {
    process.stderr.write(
      `FATAL (#19): Checkpoint definitions for serviceId "${serviceId}" cite resource-extractor ` +
        `artifact ${digest}, which is not among the artifacts printed here ` +
        `(${[...printedDigests].join(', ') || 'none'}). The artifact-generation path and the ` +
        `definition path disagree — refusing to print a provisioning bundle the deployed ` +
        `definitions do not match.\n`,
    );
    process.exit(1);
  }
}

process.stdout.write(`${JSON.stringify({ serviceId, serviceIdSource, artifacts }, null, 2)}\n`);
